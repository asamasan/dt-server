import {
  fetchIncidents,
  IncidentResponse,
} from "../clients/nswTrafficIncidents";
import { createBatches } from "../util/createBatches";
import { DataSource } from "../db/models/DataSource";
import { DATASOURCES } from "../const/datasource";
import { getConnection } from "../db/connect";
import { Suburb } from "../db/models/Suburb";
import { TrafficIncidentCategory } from "../db/models/TrafficIncidentCategory";
import { TrafficIncident } from "../db/models/TrafficIncident";
import { updateSuburbGeoJson, parseSuburbNames } from "../util/suburbUtils";
import { getTrafficIncidentCategory } from "../util/trafficIncidents";
import { Loader } from "../util/loader";
import { TrafficIncidentSuburb } from "../db/models/TrafficIncidentSuburb";
import { Op } from "sequelize";
import { DatewiseCategorySums } from "../customTypes/calculated";
import { LatLng } from "../customTypes/geometry";
import { MONTHS_TO_SEARCH } from "../const/trafficIncidents";
import { logger } from "../util/logger";

type GetIncidents = (initialise?: boolean) => Promise<void>;

const insertIncidents = async (
  results: IncidentResponse[],
  dataSource: DataSource
) => {
  const connection = getConnection();
  const suburbsCache: { [key: string]: Suburb } = {};
  const categoryCache: { [key: string]: TrafficIncidentCategory } = {};
  const loader = new Loader(results.length, "Traffic Incidents");
  const incidentResponseBatches = createBatches(results, 200);
  for (const incidentResponseBatch of incidentResponseBatches) {
    await connection.transaction(async (trx) => {
      for (const trafficIncident of incidentResponseBatch) {
        loader.tick();
        const id = trafficIncident.Hazards.features.id;
        const [lng, lat] =
          trafficIncident.Hazards.features.geometry.coordinates;

        const suburbs: Suburb[] = [];
        const suburbNames = parseSuburbNames(
          trafficIncident.Hazards.features.properties.roads[0].suburb
        );
        for (let i = 0; i < suburbNames.length; i++) {
          const suburbName = suburbNames[i];
          let suburb = suburbsCache[suburbName];
          if (!suburb) {
            [suburb] = await Suburb.findOrCreate({
              where: { name: suburbName },
              transaction: trx,
            });
          }
          suburbs.push(suburb);
        }

        const { mainCategory: subcategory } =
          trafficIncident.Hazards.features.properties;
        let trafficIncidentCategory = categoryCache[subcategory];
        if (!trafficIncidentCategory) {
          const category = getTrafficIncidentCategory(subcategory);
          [trafficIncidentCategory] =
            await TrafficIncidentCategory.findOrCreate({
              where: {
                subcategory: subcategory.toUpperCase(),
              },
              defaults: {
                category,
                subcategory,
              },
              transaction: trx,
            });
        }
        const { end, created } = trafficIncident.Hazards.features.properties;
        const [incident] = await TrafficIncident.findOrCreate({
          where: {
            id,
          },
          defaults: {
            id,
            position: {
              type: "Point",
              coordinates: [lng, lat],
            },
            created: new Date(created),
            end: end ? new Date(end) : null,
            trafficIncidentCategoryId: trafficIncidentCategory.id,
            dataSourceId: dataSource.id,
          },
          transaction: trx,
        });
        if (!incident.end && end) {
          incident.update(
            {
              end: new Date(end),
            },
            { transaction: trx }
          );
        }
        for (let i = 0; i < suburbs.length; i++) {
          const suburb = suburbs[i];
          await TrafficIncidentSuburb.findOrCreate({
            where: {
              trafficIncidentId: incident.id,
              suburbId: suburb.id,
            },
            transaction: trx,
          });
        }
      }
    });
  }
};

export const updateIncidents: GetIncidents = async (initialise = false) => {
  const dataSource = await DataSource.findOne({
    where: {
      name: DATASOURCES.trafficIncidents.name,
    },
  });
  if (!dataSource)
    throw new Error(
      `No datasource for ${DATASOURCES.trafficIncidents.name} found`
    );
  const endDate = new Date();
  const startDate = new Date();
  if (initialise) {
    endDate.setDate(0);
    endDate.setMonth(endDate.getMonth() + 1);
    startDate.setDate(0);

    for (let i = 0; i < MONTHS_TO_SEARCH; i++) {
      const results = await fetchIncidents(startDate, endDate);
      logger(`incident batch ${i + 1}/${MONTHS_TO_SEARCH}`);
      await insertIncidents(results, dataSource);

      endDate.setMonth(endDate.getMonth() - 1);
      startDate.setMonth(startDate.getMonth() - 1);
    }
  } else {
    startDate.setDate(startDate.getDate() - 2);
    const results = await fetchIncidents(startDate, endDate);
    await insertIncidents(results, dataSource);
  }
  await updateSuburbGeoJson();
};

type GetTrafficIncidentsNearPositionSignature = (
  coordinates: LatLng,
  radius: number,
  startDate: Date,
  endDate?: Date
) => Promise<DatewiseCategorySums>;

/* Returns the number of traffic incidents X meters from a coordinate */
export const getTrafficIncidentsNearPosition: GetTrafficIncidentsNearPositionSignature =
  async ({ lat, lng }, radius, startDate, endDate) => {
    const sequelize = getConnection();

    type WhereOpts = {
      created: { [Op.gte]: Date; [Op.lte]?: Date };
    };

    const whereOpts: WhereOpts = {
      created: {
        [Op.gte]: startDate,
      },
    };
    if (endDate) {
      whereOpts.created = {
        ...whereOpts.created,
        [Op.lte]: endDate,
      };
    }

    type IncidentsInRange = {
      date: string;
      category: string;
      count: number;
    };

    const incidentsInRange = (await TrafficIncident.findAll({
      attributes: [
        [sequelize.literal(`DATE("created")`), "date"],
        [sequelize.col("category"), "category"],
        [
          sequelize.cast(
            sequelize.fn("count", sequelize.col("category")),
            "int"
          ),
          "count",
        ],
      ],
      where: {
        position: sequelize.where(
          sequelize.fn(
            "st_distance",
            sequelize.fn("Geography", sequelize.col("position")),
            sequelize.fn("Geography", sequelize.fn("ST_MakePoint", lng, lat))
          ),
          {
            [Op.lte]: radius,
          }
        ),
        ...whereOpts,
      },
      include: [
        {
          attributes: [],
          model: TrafficIncidentCategory,
        },
      ],
      group: ["date", "category"],
      raw: true,
    })) as unknown as IncidentsInRange[];
    const trafficIncidentsSums: DatewiseCategorySums = {};
    for (const incidentInRange of incidentsInRange) {
      if (!trafficIncidentsSums[incidentInRange.date]) {
        trafficIncidentsSums[incidentInRange.date] = {};
      }
      trafficIncidentsSums[incidentInRange.date][incidentInRange.category] =
        incidentInRange.count;
    }

    return trafficIncidentsSums;
  };
