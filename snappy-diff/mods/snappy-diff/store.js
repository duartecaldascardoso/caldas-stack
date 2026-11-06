// Preferences and review progress, kept as JSON under Herdr's data folder so they outlive
// the dialog (each opening is a fresh copy of the mod).
import * as fs from "fs/promises";
import { appHome } from "herdr";
import { hash } from "./patch.js";
import { emptyReview } from "./review.js";

const DIR = `${appHome()}/data/snappy-diff`;
const PREFS = `${DIR}/prefs.json`;

export const DEFAULT_PREFS = { diffStyle: "split", sidebar: true, editor: "zed" };

async function readJson(path, fallback) {
  try { return { ...fallback, ...JSON.parse(await fs.readFile(path, "utf8")) }; } catch { return fallback; }
}

async function writeJson(path, value) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path, JSON.stringify(value));
}

const reviewPath = (key) => `${DIR}/review-${hash(key).toString(36)}.json`;

export const readPrefs = () => readJson(PREFS, DEFAULT_PREFS);
export const writePrefs = (prefs) => writeJson(PREFS, prefs).catch(() => {});
export const readReview = (key) => readJson(reviewPath(key), emptyReview());
export const writeReview = (key, review) => writeJson(reviewPath(key), review).catch(() => {});
