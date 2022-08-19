import express from "express";
import {
  get,
  getAggregate,
  getEmissionsByYear,
  getYears,
} from "../controllers/emissions";

const router = express.Router();

router.get("/", async (req, res) => {
  const results = await get();
  res.status(200).send(results);
});

router.get("/aggregate", async (req, res) => {
  const results = await getAggregate();
  res.status(200).send(results);
});

router.get("/yearly", async (req, res) => {
  const results = await getEmissionsByYear();
  res.status(200).send(results);
});

router.get("/years", async (req, res) => {
  const results = await getYears();
  res.status(200).send(results);
});

export { router as emissions };
