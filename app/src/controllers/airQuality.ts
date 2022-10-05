import {
  getMonthlyObservationsAQApi,
  getHourlyObservationsAQApi,
  AirQualityDataLive,
  getSites,
  getDailyObservations,
} from "../clients/nswAirQuality";
import { AirQualitySite } from "../db/models/AirQualitySite";
import { DataSource } from "../db/models/DataSource";
import { AirQualityReading } from "../db/models/AirQualityReading";
import { PollutantType } from "../db/models/AirQualityReading";
import { Op } from "sequelize";
import { UpdateFrequency, Frequency } from "../db/models/UpdateFrequency";
import { APIS } from "../const/api";

const DAYS_TO_SEARCH = 7;

export const getMonthlyObservations = async (sites: number[]) => {
  const date = new Date();
  const startDate = `${date.getFullYear()}-01-01`;
  const endDate = `${date.getFullYear()}-${
    date.getMonth() + 1
  }-${date.getDate()}`;

  const airQualityData = getMonthlyObservationsAQApi(startDate, endDate, sites);

  return airQualityData;
};

export const getCurrentObservations = async (sites: number[]) => {
  const emissions: string[] = ["NO2"];
  const currentDate = new Date();
  const currentDateString = `${currentDate.getFullYear()}-${
    currentDate.getMonth() + 1
  }-${currentDate.getDate()}`;
  const tomorrowDateString = `${currentDate.getFullYear()}-${
    currentDate.getMonth() + 1
  }-${currentDate.getDate() + 1}`;
  const observations = await getHourlyObservationsAQApi(
    emissions,
    sites,
    currentDateString,
    tomorrowDateString
  );

  const observationsBySite: { [key: number]: AirQualityDataLive } = {};
  // get the most recent observation for each site that isn't null
  observations.map((observation) => {
    if (
      !observationsBySite[observation.siteId] ||
      !observationsBySite[observation.siteId].value
    ) {
      observationsBySite[observation.siteId] = observation;
    } else if (
      observationsBySite[observation.siteId].hour < observation.hour &&
      observation.value
    ) {
      observationsBySite[observation.siteId] = observation;
    }
  });
  return Object.values(observationsBySite);
};

export const updateSites = async () => {
  const sites = await getSites();
  const dataSource = await DataSource.findOne({
    where: { name: APIS.nswAirQualitySites.name },
  });
  for (const site of sites) {
    const { name: _name, region: _region, siteId, lat, lng } = site;

    if (!lat || !lng) continue;

    const region = _region.toUpperCase();
    const name = _name.toUpperCase();
    // there are many other readings across nsw, only include those close to sydney
    // https://www.dpie.nsw.gov.au/air-quality/air-quality-concentration-data-updated-hourly
    if (!region.includes("SYDNEY") && !name.includes("SYDNEY")) continue;
    const aqSite = await AirQualitySite.findOne({
      where: {
        siteId,
      },
    });
    if (!aqSite) {
      await AirQualitySite.create({
        siteId,
        lng,
        lat,
        name,
        region,
        dataSourceId: dataSource?.id,
      });
    }
  }
};

export const updateDailyReadings = async (endDate: Date) => {
  const airQualitySites = await AirQualitySite.findAll({});
  const siteToAirQualitySites: { [key: string]: AirQualitySite } = {};
  airQualitySites.forEach((airQualitySite) => {
    siteToAirQualitySites[airQualitySite.siteId] = airQualitySite;
  });
  const startDate = new Date(endDate.getTime());
  startDate.setDate(endDate.getDate() - DAYS_TO_SEARCH);

  const todayParsed = `${endDate.getFullYear()}-${
    endDate.getMonth() + 1
  }-${endDate.getDay()}`;

  const startDateParsed = `${startDate.getFullYear()}-${
    startDate.getMonth() + 1
  }-${startDate.getDay()}`;

  const observations = (
    await getDailyObservations(
      [PollutantType.NO2],
      airQualitySites.map((airQualitySite) => airQualitySite.siteId),
      startDateParsed,
      todayParsed
    )
  ).filter((observation) => {
    const date = new Date(observation.date);
    if (date < startDate || date > endDate) return false;
    return true;
  });

  const dailyReadingsInDb = await AirQualityReading.findAll({
    where: {
      date: {
        [Op.gte]: startDate,
        [Op.lte]: endDate,
      },
    },
  });

  const dailyReadingsMapped: {
    [key: string]: { [key: number]: AirQualityReading };
  } = {};
  dailyReadingsInDb.forEach((dailyReading) => {
    const year = dailyReading.date.getFullYear();
    const month = String(dailyReading.date.getMonth() + 1).padStart(2, "0");
    const day = String(dailyReading.date.getDate()).padStart(2, "0");
    const dateToString = `${year}-${month}-${day}`;

    if (!dailyReadingsMapped[dateToString]) {
      dailyReadingsMapped[dateToString] = {};
    }
    dailyReadingsMapped[dateToString][dailyReading.airQualitySiteId] =
      dailyReading;
  });

  const countLogs = {
    create: 0,
    update: 0,
  };

  const updateFrequency = await UpdateFrequency.findOne({
    where: { frequency: Frequency.DAILY },
  });
  const dataSource = await DataSource.findOne({
    where: {
      name: APIS.nswAirQualityReadings.name,
    },
  });
  if (!updateFrequency || !updateFrequency.id)
    throw new Error(`updateFrequency not found: ${Frequency.DAILY}`);
  await Promise.all(
    observations.map(async (observation) => {
      const airQualitySiteId = siteToAirQualitySites[observation.siteId].id;

      const existingReading =
        dailyReadingsMapped[observation.date] &&
        dailyReadingsMapped[observation.date][airQualitySiteId];

      if (!existingReading) {
        await AirQualityReading.create({
          date: new Date(observation.date),
          value: observation.value,
          type: observation.type,
          dataSourceId: dataSource?.id,
          airQualitySiteId: airQualitySiteId,
          updateFrequencyId: updateFrequency.id,
        });

        countLogs.create = countLogs.create + 1;
      }
      if (existingReading && existingReading.value === null) {
        await existingReading.update({ value: observation.value });
        countLogs.update = countLogs.update + 1;
      }
    })
  );
};
