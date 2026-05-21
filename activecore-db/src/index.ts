import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// When started from the repo root (e.g. `npm --prefix activecore-db ...`), CWD may not be activecore-db/.
// Use only activecore-db/.env.local for runtime configuration.
// `.env.local` is the single source of truth; `.env.local.example` is only a template.
const envPath = path.resolve(__dirname, '..', '.env.local');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
} else {
  dotenv.config();
}

// Initialize Sentry FIRST, before any other code
import { initSentry, sentryRequestHandler, sentryErrorHandler } from './config/sentry.config';
initSentry();

import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool, initializeDatabase } from './config/db.config';
import axios from 'axios';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import rateLimit from 'express-rate-limit';
import logger, { logError, logWarn, logInfo, logDebug } from './utils/logger';
import { securityHeaders } from './middleware/securityHeaders';
// Avoid startup crash if OPENAI_API_KEY missing
let openai: OpenAI | undefined;
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  openai = undefined;
}
import nodemailer, { Transporter } from 'nodemailer';
import crypto from 'crypto';
import qrTokenRouter from './routes/qrToken';
import { sendAbsenceReminders } from './utils/absenceReminder.service';
import { sendAbsenceReminderEmail } from './utils/brevo.service';
import * as BrevoService from './utils/brevo.service';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

const debugLog = (...args: any[]) => {
  if (!isProduction) {
    console.log(...args);
  }
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// If behind a reverse proxy (Vercel/Nginx/Cloudflare), enable this so req.ip reflects the real client.
// Set TRUST_PROXY=1 (or any truthy value) in production.
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0' && process.env.TRUST_PROXY.toLowerCase() !== 'false') {
  app.set('trust proxy', 1);
}

// ============================================
// SECURITY: Validate JWT_SECRET at startup
// ============================================
// In production we require JWT_SECRET explicitly.
// In development, allow the dev fallback secret (see getJwtSecret()) but warn.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  const isDev = process.env.NODE_ENV === 'development';
  const message = [
    'JWT_SECRET is missing or too short. It should be at least 32 characters.',
    'Fix: set JWT_SECRET in activecore-db/.env.local (local) or in your host env vars (production).',
    'Tip: run `npm run gen:jwt` in activecore-db to generate one.',
  ].join('\n   ');

  if (isDev) {
    console.warn(`\n⚠️  ${message}`);
    console.warn('   Continuing in development with a fallback secret (tokens will not be stable across restarts).\n');
  } else {
    console.error(`\n❌ ${message}\n`);
    process.exit(1);
  }
}

// Track OpenAI availability globally
let openaiAvailable = true;

// ============================================
// RATE LIMITING: Protect against brute force
// ============================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 20), // Limit each IP to N login attempts per windowMs
  message: 'Too many login attempts. Please try again later.',
  skipSuccessfulRequests: true,
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parsePositiveInt(process.env.REGISTER_RATE_LIMIT_MAX, 10), // Limit each IP to N registration attempts per hour
  message: 'Too many registration attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: parsePositiveInt(process.env.GENERAL_RATE_LIMIT_MAX, 300), // General API limit: requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: parsePositiveInt(process.env.PAYMENT_RATE_LIMIT_MAX, 30),
  message: 'Too many payment attempts. Please wait and try again.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Sentry request handler - DISABLED for debugging
// app.use(sentryRequestHandler);

app.use(express.json());

// Apply security headers to all responses
app.use(securityHeaders);

// Apply general rate limiting to all requests
app.use(generalLimiter);



// CORS: allow all in development; set safe origin + support preflight
if (process.env.NODE_ENV === 'development') {
  app.use(cors({ origin: true, credentials: true }));
  // Ensure pre-flight passes
  app.options('*', cors({ origin: true, credentials: true }));
} else {
  // Production: Use explicit allowlist
  const allowedOrigins = (process.env.ALLOWED_ORIGINS?.split(',') || process.env.FRONTEND_URL?.split(',') || ['http://localhost:8100'])
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  
  const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      const originNormalized = origin.replace(/\/$/, '');
      const allowLocalhostOrigins = process.env.ALLOW_LOCALHOST === 'true';
      const isLocalhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(originNormalized);
      const isAllowed = 
        allowedOrigins.includes(originNormalized) ||
        (allowLocalhostOrigins && isLocalhostOrigin) ||
        (process.env.ALLOW_NGROK === 'true' && originNormalized.includes('ngrok.io'));
      
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('CORS not allowed'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
  };
  
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
}

// PayPal API configuration
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const normalizedPayPalMode = (process.env.PAYPAL_MODE || '').trim().toLowerCase();
const PAYPAL_MODE =
  normalizedPayPalMode === 'live' ||
  (normalizedPayPalMode !== 'sandbox' && process.env.NODE_ENV === 'production')
    ? 'live'
    : 'sandbox';
const PAYPAL_API_URL = PAYPAL_MODE === 'live' 
  ? 'https://api.paypal.com/v2'
  : 'https://api.sandbox.paypal.com/v2';

// use env-driven model name so it's easy to switch
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const PROJECT_ROOT_PATH = path.resolve(__dirname, '..', '..');
const FNRI_GUIDELINES_PATH = path.resolve(PROJECT_ROOT_PATH, 'fnri_guidelines.json');
const PDRI_REFERENCE_PATH = path.resolve(PROJECT_ROOT_PATH, 'PDRI-2018.fullllll.followdis.csv');

type PDRIQuickFacts = {
  adultAmdr: string;
  adultEnergyRef: string;
  sugarLimit: string;
  sodiumLimit: string;
  potassiumRecommendation: string;
};

function readJsonFileSafe(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readTextFileSafe(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function extractPdriQuickFacts(raw: string): PDRIQuickFacts {
  const defaults: PDRIQuickFacts = {
    adultAmdr: 'Adults (>=19): Protein 10-15%, Fat 15-30%, Carbohydrates 55-75%',
    adultEnergyRef: 'Adults 19-29 reference: Male ~2530 kcal/day, Female ~1930 kcal/day',
    sugarLimit: 'Free sugars: less than 10% of total energy',
    sodiumLimit: 'Sodium: less than 2 g/day (adults)',
    potassiumRecommendation: 'Potassium: around 3510 mg/day (adults)',
  };

  if (!raw) return defaults;

  const normalizeRange = (value: string) => value.replace(/-/g, '–').trim();

  const amdrMatch = raw.match(/≥\s*19\s+(\d+[\-–]\d+)\s+(\d+[\-–]\d+)\s+(\d+[\-–]\d+)/);
  const maleFemaleEnergyMatch = raw.match(/19[\-–]29\s+60\.5\s+52\.5\s+([0-9,]+)\s+([0-9,]+)/);
  const sugarMatch = raw.match(/Free sugars[^\n]*<\s*10%[^\n]*/i);
  const sodiumMatch = raw.match(/Sodium[^\n]*<\s*2\s*g[^\n]*/i);
  const potassiumMatch = raw.match(/Potassium[^\n]*3,?510\s*mg[^\n]*/i);

  return {
    adultAmdr: amdrMatch
      ? `Adults (>=19): Protein ${normalizeRange(amdrMatch[1])}, Fat ${normalizeRange(amdrMatch[2])}, Carbohydrates ${normalizeRange(amdrMatch[3])}`
      : defaults.adultAmdr,
    adultEnergyRef: maleFemaleEnergyMatch
      ? `Adults 19-29 reference: Male ~${maleFemaleEnergyMatch[1]} kcal/day, Female ~${maleFemaleEnergyMatch[2]} kcal/day`
      : defaults.adultEnergyRef,
    sugarLimit: sugarMatch ? sugarMatch[0].trim() : defaults.sugarLimit,
    sodiumLimit: sodiumMatch ? sodiumMatch[0].trim() : defaults.sodiumLimit,
    potassiumRecommendation: potassiumMatch ? potassiumMatch[0].trim() : defaults.potassiumRecommendation,
  };
}

const fnriGuidelines = readJsonFileSafe(FNRI_GUIDELINES_PATH) || {};
const pdriQuickFacts = extractPdriQuickFacts(readTextFileSafe(PDRI_REFERENCE_PATH));

function listToCsv(values: any, fallback = 'none specified'): string {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  return values.map((v) => String(v || '').trim()).filter(Boolean).join(', ');
}

function buildNationalNutritionStandardsBlock(targets: any): string {
  const plateDistribution = fnriGuidelines?.diet_framework?.plate_distribution || {};
  const foodGroups = fnriGuidelines?.diet_framework?.food_groups || {};
  const mealRequirements = fnriGuidelines?.meal_structure?.each_meal_requirements || [];
  const coreGuidelines = fnriGuidelines?.core_guidelines || [];
  const priorityRules = fnriGuidelines?.nutritional_rules?.priority || [];
  const limitRules = fnriGuidelines?.nutritional_rules?.limit || [];
  const localFoods = fnriGuidelines?.local_food_preference || {};

  const localCarbs = listToCsv(localFoods.carbs, 'rice, corn, root crops');
  const localProteins = listToCsv(localFoods.protein, 'fish, chicken, egg, legumes');
  const localVegetables = listToCsv(localFoods.vegetables, 'leafy and local vegetables');
  const localFruits = listToCsv(localFoods.fruits, 'local seasonal fruits');

  return `
National Standards to follow (FNRI-DOST Philippines + PDRI):
- Follow Pinggang Pinoy meal balance target per plate: vegetables ${plateDistribution.vegetables || '30%'}, fruits ${plateDistribution.fruits || '20%'}, protein ${plateDistribution.protein || '25%'}, carbohydrates ${plateDistribution.carbohydrates || '25%'}.
- Use Go/Grow/Glow principle in practical meal composition:
  Go = ${foodGroups.Go || 'carbohydrate source'}
  Grow = ${foodGroups.Grow || 'protein source'}
  Glow = ${foodGroups.Glow || 'fruit/vegetable source'}
- Each main meal should contain: ${listToCsv(mealRequirements, 'vegetable + protein + carbohydrate source')}.
- Prefer local Filipino whole-food choices: carbs (${localCarbs}); proteins (${localProteins}); vegetables (${localVegetables}); fruits (${localFruits}).
- PDRI macronutrient range reference: ${pdriQuickFacts.adultAmdr}
- PDRI adult energy reference: ${pdriQuickFacts.adultEnergyRef}
- Public health limits: ${pdriQuickFacts.sugarLimit}; ${pdriQuickFacts.sodiumLimit}; ${pdriQuickFacts.potassiumRecommendation}
- Nutrition priorities: ${listToCsv(priorityRules, 'balanced macros and fiber')}
- Nutrition limits: ${listToCsv(limitRules, 'avoid excess sugar/sodium/saturated fat')}
- Ensure generated meals remain aligned with user targets (${targets?.calories ?? 2000} kcal, ${targets?.protein ?? 150}g protein, ${targets?.carbs ?? 250}g carbs, ${targets?.fats ?? 70}g fats) while respecting FNRI/PDRI constraints.
- Core FNRI reminders: ${listToCsv(coreGuidelines, 'eat variety, emphasize vegetables/fruits, hydrate safely')}
`;
}

type NutritionCitation = {
  id: string;
  title: string;
  organization: string;
  url: string;
  summary: string;
};

const NUTRITION_CITATIONS: NutritionCitation[] = [
  {
    id: 'fnri_pinggang_pinoy',
    title: 'Pinggang Pinoy for Filipino adults',
    organization: 'FNRI-DOST / NNC',
    url: 'https://www.fnri.dost.gov.ph/images/sources/PinggangPinoy-Adult.pdf',
    summary: 'Filipino plate model using Go, Grow, and Glow food groups for balanced meals.',
  },
  {
    id: 'fnri_pdri',
    title: 'Philippine Dietary Reference Intakes 2015 Summary Tables',
    organization: 'FNRI-DOST',
    url: 'https://fnri.dost.gov.ph/images/images/news/PDRI-2018.pdf',
    summary: 'Philippine reference values for adult energy needs and macronutrient distribution ranges.',
  },
  {
    id: 'who_healthy_diet',
    title: 'Healthy diet',
    organization: 'World Health Organization',
    url: 'https://www.who.int/en/news-room/fact-sheets/detail/healthy-diet',
    summary: 'General healthy diet guidance including sodium, free sugars, fruits, vegetables, and fat quality.',
  },
  {
    id: 'cdc_diabetes_meal_planning',
    title: 'Diabetes Meal Planning',
    organization: 'CDC',
    url: 'https://www.cdc.gov/diabetes/healthy-eating/diabetes-meal-planning.html',
    summary: 'Diabetes meal planning guidance using carb awareness and the plate method.',
  },
  {
    id: 'aha_hypertension_dash',
    title: 'Managing Blood Pressure with a Heart-Healthy Diet',
    organization: 'American Heart Association',
    url: 'https://www.heart.org/en/health-topics/high-blood-pressure/changes-you-can-make-to-manage-high-blood-pressure/managing-blood-pressure-with-a-heart-healthy-diet',
    summary: 'DASH-style eating guidance for blood pressure, emphasizing sodium limits and healthy food sources.',
  },
  {
    id: 'aha_cholesterol',
    title: 'Prevention and Treatment of High Cholesterol',
    organization: 'American Heart Association',
    url: 'https://www.heart.org/en/health-topics/cholesterol/prevention-and-treatment-of-high-cholesterol-hyperlipidemia',
    summary: 'Heart-healthy eating guidance that limits saturated and trans fat and emphasizes fiber and lean proteins.',
  },
  {
    id: 'niddk_ckd',
    title: 'Healthy Eating for Adults with Chronic Kidney Disease',
    organization: 'NIDDK',
    url: 'https://www.niddk.nih.gov/health-information/kidney-disease/chronic-kidney-disease-ckd/healthy-eating-adults-chronic-kidney-disease',
    summary: 'CKD nutrition guidance covering sodium, potassium, phosphorus, protein, and individualized dietitian support.',
  },
  {
    id: 'fda_food_allergies',
    title: 'Food Allergies: What You Need to Know',
    organization: 'FDA',
    url: 'https://www.fda.gov/food/buy-store-serve-safe-food/food-allergies-what-you-need-know',
    summary: 'Major food allergen list and strict avoidance guidance for diagnosed food allergies.',
  },
  {
    id: 'cdc_weight_activity',
    title: 'Physical Activity and Your Weight and Health',
    organization: 'CDC',
    url: 'https://www.cdc.gov/healthy-weight-growth/physical-activity/index.html',
    summary: 'Healthy weight guidance connecting calorie balance, diet, and regular physical activity.',
  },
];

const NUTRITION_CITATION_BY_ID = new Map(NUTRITION_CITATIONS.map((source) => [source.id, source]));

function uniqueStrings(values: any[]): string[] {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function normalizeTokenValue(input: any): string {
  return String(input || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeHealthConditions(input: any): string[] {
  const aliases: Record<string, string> = {
    overweight: 'obesity_overweight',
    obesity: 'obesity_overweight',
    obese: 'obesity_overweight',
    high_blood_pressure: 'hypertension',
    bp: 'hypertension',
    cardiovascular: 'dyslipidemia_cardiovascular',
    heart_disease: 'dyslipidemia_cardiovascular',
    dyslipidemia: 'dyslipidemia_cardiovascular',
    high_cholesterol: 'dyslipidemia_cardiovascular',
    ckd: 'chronic_kidney_disease',
    kidney_disease: 'chronic_kidney_disease',
    allergies: 'allergy',
  };

  return uniqueStrings(normalizeSelectionList(input).map((value) => aliases[normalizeTokenValue(value)] || normalizeTokenValue(value)))
    .filter((value) => [
      'hypertension',
      'diabetes',
      'obesity_overweight',
      'dyslipidemia_cardiovascular',
      'chronic_kidney_disease',
      'allergy',
    ].includes(value));
}

function normalizeDietaryRestrictions(input: any): any {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    cultural: normalizeTokenValue(raw.cultural || 'filipino') || 'filipino',
    religious: normalizeTokenValue(raw.religious || ''),
    foodPreferences: uniqueStrings(normalizeSelectionList(raw.foodPreferences).map(normalizeTokenValue)),
  };
}

function inferDietFromRestrictions(dietaryRestrictions: any): string {
  if (!dietaryRestrictions || typeof dietaryRestrictions !== 'object') return '';
  if (dietaryRestrictions.religious === 'vegetarian') return 'vegetarian';
  if (Array.isArray(dietaryRestrictions.foodPreferences) && dietaryRestrictions.foodPreferences.includes('vegetarian')) return 'vegetarian';
  return '';
}

function getRestrictionTokensFromProfile(dietaryRestrictions: any, healthConditions: string[]): string[] {
  const tokens: string[] = [];
  const religious = normalizeTokenValue(dietaryRestrictions?.religious);
  const foodPreferences = normalizeSelectionList(dietaryRestrictions?.foodPreferences).map(normalizeTokenValue);

  if (religious === 'halal') tokens.push('halal', 'no_pork', 'no_alcohol');
  if (religious === 'no_pork') tokens.push('no_pork');
  if (religious === 'no_beef') tokens.push('no_beef');
  if (foodPreferences.includes('low_sodium') || healthConditions.includes('hypertension')) tokens.push('low_sodium');
  if (foodPreferences.includes('no_fried_foods') || healthConditions.includes('dyslipidemia_cardiovascular')) tokens.push('no_fried_foods');
  if (foodPreferences.includes('budget_friendly')) tokens.push('budget_friendly');

  return uniqueStrings(tokens);
}

function normalizeMealPlannerProfile(reqBody: any, normalizedDiet: string, allRestrictionTokens: string[]) {
  const demographicsRaw = reqBody?.demographics && typeof reqBody.demographics === 'object' ? reqBody.demographics : {};
  const socioeconomicRaw = reqBody?.socioeconomic && typeof reqBody.socioeconomic === 'object' ? reqBody.socioeconomic : {};
  const lifestyleRaw = reqBody?.lifestyleFactors && typeof reqBody.lifestyleFactors === 'object' ? reqBody.lifestyleFactors : {};

  return {
    demographics: {
      age: Number(demographicsRaw.age) || null,
      sex: normalizeTokenValue(demographicsRaw.sex || ''),
      heightCm: Number(demographicsRaw.heightCm) || null,
      weightKg: Number(demographicsRaw.weightKg) || null,
    },
    healthConditions: normalizeHealthConditions(reqBody?.healthConditions || reqBody?.healthCondition),
    dietaryRestrictions: normalizeDietaryRestrictions(reqBody?.dietaryRestrictions),
    socioeconomic: {
      status: normalizeTokenValue(socioeconomicRaw.status || 'middle') || 'middle',
      dailyBudgetPhp: Number(socioeconomicRaw.dailyBudgetPhp) || null,
    },
    lifestyleFactors: {
      physicalActivity: normalizeTokenValue(lifestyleRaw.physicalActivity || reqBody?.lifestyle || 'moderate') || 'moderate',
      smokingStatus: normalizeTokenValue(lifestyleRaw.smokingStatus || 'none') || 'none',
      alcoholIntake: normalizeTokenValue(lifestyleRaw.alcoholIntake || 'none') || 'none',
    },
    diet: normalizedDiet,
    restrictionTokens: allRestrictionTokens,
  };
}

function getCitationIdsForProfile(profile: any, hasAllergies: boolean): string[] {
  const ids = ['fnri_pinggang_pinoy', 'fnri_pdri', 'who_healthy_diet'];
  const conditions = Array.isArray(profile?.healthConditions) ? profile.healthConditions : [];
  if (conditions.includes('hypertension')) ids.push('aha_hypertension_dash');
  if (conditions.includes('diabetes')) ids.push('cdc_diabetes_meal_planning');
  if (conditions.includes('obesity_overweight')) ids.push('cdc_weight_activity');
  if (conditions.includes('dyslipidemia_cardiovascular')) ids.push('aha_cholesterol');
  if (conditions.includes('chronic_kidney_disease')) ids.push('niddk_ckd');
  if (conditions.includes('allergy') || hasAllergies) ids.push('fda_food_allergies');
  return uniqueStrings(ids);
}

function selectCitations(citationIds: string[]): NutritionCitation[] {
  return uniqueStrings(citationIds)
    .map((id) => NUTRITION_CITATION_BY_ID.get(id))
    .filter(Boolean) as NutritionCitation[];
}

function buildNutritionProfilePromptBlock(profile: any, targets: any): string {
  const conditions = Array.isArray(profile?.healthConditions) && profile.healthConditions.length > 0
    ? profile.healthConditions.join(', ')
    : 'none specified';
  const prefs = Array.isArray(profile?.dietaryRestrictions?.foodPreferences) && profile.dietaryRestrictions.foodPreferences.length > 0
    ? profile.dietaryRestrictions.foodPreferences.join(', ')
    : 'none specified';
  const demo = profile?.demographics || {};

  return `
User nutrition profile:
- Demographics: age ${demo.age ?? 'not specified'}, sex ${demo.sex || 'not specified'}, height ${demo.heightCm ?? 'not specified'} cm, weight ${demo.weightKg ?? 'not specified'} kg.
- Health conditions: ${conditions}.
- Dietary restrictions: cultural ${profile?.dietaryRestrictions?.cultural || 'filipino'}, religious ${profile?.dietaryRestrictions?.religious || 'none'}, food preferences ${prefs}.
- Budget: ${profile?.socioeconomic?.status || 'middle'}; daily budget PHP ${profile?.socioeconomic?.dailyBudgetPhp ?? 'not specified'}.
- Lifestyle factors: physical activity ${profile?.lifestyleFactors?.physicalActivity || 'moderate'}, smoking ${profile?.lifestyleFactors?.smokingStatus || 'none'}, alcohol ${profile?.lifestyleFactors?.alcoholIntake || 'none'}.
- Macro targets: ${targets?.calories ?? 2000} kcal, ${targets?.protein ?? 120}g protein, ${targets?.carbs ?? 250}g carbs, ${targets?.fats ?? 65}g fats.
Clinical rules:
- Hypertension: favor DASH-style, lower-sodium choices; avoid salty condiments, processed meats, and salty snacks.
- Diabetes: use consistent carbohydrate portions, pair carbohydrates with protein/fiber, and avoid added sugars/refined grains when possible.
- Obesity/overweight: keep portions aligned to calorie target and emphasize lean protein, vegetables, and filling whole foods.
- Dyslipidemia/cardiovascular: limit fried foods and saturated/trans fat; prefer fish, legumes, vegetables, whole grains, and lean proteins.
- Chronic kidney disease: avoid high-sodium choices and do not force high protein; potassium/phosphorus/protein limits vary by CKD stage, so keep a caution note.
- Allergy: strictly avoid selected allergens and possible allergen ingredients.
`;
}

function buildEvidenceSummary(profile: any, targets: any, citationIds: string[]): string[] {
  const notes: string[] = [
    `Balanced against the requested targets: ${targets?.calories ?? 2000} kcal, ${targets?.protein ?? 120}g protein, ${targets?.carbs ?? 250}g carbs, ${targets?.fats ?? 65}g fats.`,
    'Uses Filipino plate guidance and PDRI macronutrient ranges as the baseline for meal balance.',
  ];
  const conditions = Array.isArray(profile?.healthConditions) ? profile.healthConditions : [];
  if (conditions.includes('hypertension')) notes.push('Hypertension input adds lower-sodium and DASH-style filtering.');
  if (conditions.includes('diabetes')) notes.push('Diabetes input adds consistent carbohydrate, protein/fiber pairing, and added-sugar caution.');
  if (conditions.includes('obesity_overweight')) notes.push('Obesity/overweight input keeps portions tied to the calorie target and filling whole-food choices.');
  if (conditions.includes('dyslipidemia_cardiovascular')) notes.push('Dyslipidemia/cardiovascular input favors lean proteins and limits fried or saturated-fat-heavy dishes.');
  if (conditions.includes('chronic_kidney_disease')) notes.push('CKD input adds sodium caution; kidney-specific potassium, phosphorus, fluid, and protein limits should be confirmed by a clinician or renal dietitian.');
  if (conditions.includes('allergy') || citationIds.includes('fda_food_allergies')) notes.push('Allergy input filters selected major allergens from meal choices where ingredient data is available.');
  if (profile?.socioeconomic?.dailyBudgetPhp) notes.push(`Budget input prefers local, practical ingredients around PHP ${profile.socioeconomic.dailyBudgetPhp}/day.`);
  return notes;
}

function filterDishesByHealthProfile<T extends any>(source: T[], healthConditions: string[], foodPreferences: string[] = []): T[] {
  if (!Array.isArray(source) || source.length === 0) return source;
  const conditions = Array.isArray(healthConditions) ? healthConditions : [];
  const prefs = Array.isArray(foodPreferences) ? foodPreferences : [];
  const avoidKeywords: string[] = [];

  if (conditions.includes('hypertension') || prefs.includes('low_sodium')) {
    avoidKeywords.push('soy sauce', 'toyo', 'patis', 'fish sauce', 'bagoong', 'salted', 'processed', 'ham', 'bacon', 'sausage', 'longganisa', 'hotdog');
  }
  if (conditions.includes('diabetes')) {
    avoidKeywords.push('sugar', 'sweetened', 'syrup', 'condensed milk', 'dessert');
  }
  if (conditions.includes('obesity_overweight') || conditions.includes('dyslipidemia_cardiovascular') || prefs.includes('no_fried_foods')) {
    avoidKeywords.push('deep fried', 'crispy', 'chicharon', 'bagnet', 'lechon', 'pork belly', 'lard');
  }
  if (conditions.includes('chronic_kidney_disease')) {
    avoidKeywords.push('bagoong', 'patis', 'soy sauce', 'toyo', 'salted', 'processed', 'sardines');
  }

  if (avoidKeywords.length === 0) return source;
  const filtered = source.filter((dish: any) => {
    const hay = dishTextForFilter(dish);
    return !avoidKeywords.some((kw) => hay.includes(kw));
  });

  return filtered.length > 0 ? filtered : source;
}

function buildMealSuitability(meal: any, profile: any, citationIds: string[]) {
  const notes: string[] = ['Aligned with the submitted calorie and macronutrient goals.'];
  const ids: string[] = ['fnri_pinggang_pinoy', 'fnri_pdri'];
  const conditions = Array.isArray(profile?.healthConditions) ? profile.healthConditions : [];
  const mealText = dishTextForFilter(meal);

  if (conditions.includes('hypertension')) {
    notes.push('Prepared as a lower-sodium choice by avoiding salty or highly processed ingredients where possible.');
    ids.push('aha_hypertension_dash', 'who_healthy_diet');
  }
  if (conditions.includes('diabetes')) {
    notes.push('Uses portion-controlled carbohydrates with protein or fiber to support steadier blood sugar response.');
    ids.push('cdc_diabetes_meal_planning');
  }
  if (conditions.includes('obesity_overweight')) {
    notes.push('Portion-scaled to the calorie target and includes filling protein or vegetable ingredients.');
    ids.push('cdc_weight_activity');
  }
  if (conditions.includes('dyslipidemia_cardiovascular')) {
    notes.push('Favors leaner, less-fried choices and limits saturated/trans-fat-heavy ingredients where ingredient data allows.');
    ids.push('aha_cholesterol');
  }
  if (conditions.includes('chronic_kidney_disease')) {
    notes.push('Uses sodium-aware filtering; CKD protein, potassium, phosphorus, and fluid needs must be individualized.');
    ids.push('niddk_ckd');
  }
  if (conditions.includes('allergy') || citationIds.includes('fda_food_allergies')) {
    notes.push('Filtered against selected major allergens based on available meal names and ingredient data.');
    ids.push('fda_food_allergies');
  }
  if (profile?.dietaryRestrictions?.religious === 'halal' || profile?.dietaryRestrictions?.religious === 'no_pork') {
    const containsPork = /pork|baboy|tocino|longganisa|liempo|bacon|ham/.test(mealText);
    notes.push(containsPork ? 'Review needed: this meal may conflict with the no-pork restriction.' : 'Respects the selected no-pork religious restriction.');
  }

  return {
    suitabilityNotes: uniqueStrings(notes).slice(0, 6),
    citationIds: uniqueStrings(ids.filter((id) => citationIds.includes(id) || id === 'fnri_pinggang_pinoy' || id === 'fnri_pdri')).slice(0, 6),
  };
}

function annotateWeekPlanWithEvidence(weekPlan: any[], profile: any, citationIds: string[]) {
  if (!Array.isArray(weekPlan)) return weekPlan;
  return weekPlan.map((day: any) => {
    const meals = day?.meals && typeof day.meals === 'object' ? day.meals : {};
    const annotatedMeals = Object.entries(meals).reduce((acc: any, [key, meal]) => {
      const suitability = buildMealSuitability(meal, profile, citationIds);
      acc[key] = {
        ...(meal as any),
        suitabilityNotes: suitability.suitabilityNotes,
        citationIds: suitability.citationIds,
      };
      return acc;
    }, {});
    return { ...day, meals: annotatedMeals };
  });
}

// Trusted Filipino meals (USDA/DOST-PH)
const trustedFilipinoMeals = [
  "Chicken Adobo", "Pork Adobo", "Beef Tapa", "Bangus Sinigang", "Tinolang Manok", "Laing",
  "Pinakbet", "Sinigang na Baboy", "Tortang Talong", "Ginisang Monggo", "Paksiw na Isda",
  "Pancit Bihon", "Arroz Caldo", "Kare-Kare", "Paksiw na Lechon", "Ensaladang Talong",
  "Inihaw na Liempo", "Lumpiang Sariwa", "Paksiw na Bangus", "Ginataang Gulay", "La Paz Batchoy",
  "Dinuguan", "Menudo", "Bicol Express", "Pochero", "Bulalo", "Pancit Canton", "Tapsilog",
  "Tocilog", "Longsilog", "Daing na Bangus", "Tinapang Bangus", "Chicken Inasal", "Paksiw na Pata",
  "Paksiw na Tilapia", "Ginisang Ampalaya", "Ginisang Sitaw at Kalabasa", "Ginisang Pechay",
  "Ginisang Repolyo", "Ginisang Sayote", "Ginisang Upo", "Ginisang Patola", "Ginisang Togue",
  "Ginisang Okra", "Ginisang Malunggay", "Ginisang Kangkong", "Ginisang Alugbati", "Ginisang Bataw",
  "Ginisang Sigarilyas", "Pancit Palabok", "Pancit Malabon", "Pancit Habhab", "Pancit Molo",
  "Sinigang na Hipon", "Sinigang na Isda", "Sinigang na Baka", "Pritong Tilapia", "Pritong Bangus",
  "Tinolang Tahong", "Tinolang Isda", "Tinolang Baboy", "Tinolang Hipon", "Tinolang Gulay",
  "Pinapaitan", "Papaitan", "Igado", "Bagnet", "Dinakdakan", "Kilawin", "Paksiw na Pata",
  "Paksiw na Lechon", "Paksiw na Tilapia", "Paksiw na Bangus", "Paksiw na Galunggong",
  "Paksiw na Dilis", "Paksiw na Tulingan", "Paksiw na Pusit", "Paksiw na Baboy", "Paksiw na Manok",
  "Paksiw na Baka", "Paksiw na Hipon", "Paksiw na Gulay", "Paksiw na Labanos", "Paksiw na Ampalaya",
  "Paksiw na Talong", "Paksiw na Okra", "Paksiw na Sitaw", "Paksiw na Kalabasa", "Paksiw na Upo",
  "Paksiw na Patola", "Paksiw na Bataw", "Paksiw na Sigarilyas"
];

// Extended trustedFilipinoMealsDetailed with more meals and macros
const trustedFilipinoMealsDetailed = [
  { name: "Chicken Adobo", ingredients: ["chicken thighs","soy sauce","vinegar","garlic","bay leaves","black pepper","oil","water"], calories: 480, protein: 36, carbs: 50, fats: 14, fiber: 2, recipe: "1. Heat oil in a pan and sauté garlic until fragrant\n2. Add chicken pieces and brown on all sides\n3. Pour in soy sauce and vinegar, add bay leaves\n4. Simmer covered for 30 minutes until chicken is tender\n5. Season with pepper and serve hot with rice" },
  { name: "Pork Adobo", ingredients: ["pork belly","soy sauce","vinegar","garlic cloves","bay leaves","black pepper","cooking oil","water"], calories: 520, protein: 32, carbs: 52, fats: 22, fiber: 2, recipe: "1. Cut pork belly into bite-sized pieces\n2. Heat oil and sauté minced garlic until fragrant\n3. Brown pork pieces on all sides for 5 minutes\n4. Add soy sauce, vinegar, and bay leaves\n5. Simmer for 40 minutes until pork is tender and sauce reduces" },
  { name: "Tapsilog", ingredients: ["beef tapa","garlic","rice","egg","butter","salt","pepper"], calories: 520, protein: 36, carbs: 48, fats: 16, fiber: 2, recipe: "1. Fry garlic rice: heat butter and sauté minced garlic, add cooked rice\n2. Cook beef tapa on a hot pan until crispy and caramelized\n3. Fry an egg sunny-side up in butter\n4. Plate the garlic rice, tapa, and fried egg together\n5. Season with salt and pepper to taste" },
  { name: "Bangus Sinigang", ingredients: ["milkfish","tamarind paste","radish","spinach","string beans","ginger","garlic","onion","salt","pepper"], calories: 410, protein: 32, carbs: 46, fats: 10, fiber: 3, recipe: "1. Boil water with tamarind paste and ginger slices for 5 minutes\n2. Add radish and onion, simmer for 5 minutes\n3. Add milkfish and string beans, simmer for 8 minutes\n4. Add spinach and cook until wilted (2 minutes)\n5. Season with salt and pepper, serve hot" },
  { name: "Tinolang Manok", ingredients: ["chicken","ginger","malunggay leaves","papaya","garlic","onion","fish sauce","broth","oil"], calories: 390, protein: 34, carbs: 44, fats: 8, fiber: 3, recipe: "1. Heat oil and sauté ginger, garlic, and onion\n2. Add chicken and cook until no longer pink\n3. Pour in broth and simmer for 15 minutes\n4. Add papaya cubes and simmer for 5 minutes\n5. Add malunggay leaves, fish sauce, and cook for 2 minutes" },
  { name: "Laing", ingredients: ["taro leaves","coconut milk","garlic","onion","ginger","chili","shrimp paste","salt"], calories: 350, protein: 12, carbs: 38, fats: 16, fiber: 5, recipe: "1. Blanch taro leaves in boiling salted water for 5 minutes, drain well\n2. Sauté garlic, onion, and ginger in oil\n3. Add shrimp paste and cook for 1 minute\n4. Add taro leaves and coconut milk, simmer for 10 minutes\n5. Add chili and salt to taste, cook for 2 more minutes" },
  { name: "Pinakbet", ingredients: ["eggplant","ampalaya","string beans","okra","squash","shrimp paste","garlic","onion","tomato","anchovy"], calories: 300, protein: 12, carbs: 30, fats: 10, fiber: 6, recipe: "1. Heat oil and sauté garlic, onion, and shrimp paste\n2. Add ampalaya and cook for 2 minutes\n3. Add squash and tomato, simmer for 5 minutes\n4. Add eggplant, string beans, and okra\n5. Simmer until vegetables are tender (8 minutes), season to taste" },
  { name: "Pancit Bihon", ingredients: ["bihon noodles","chicken","carrots","cabbage","garlic","onion","soy sauce","cooking oil","broth"], calories: 420, protein: 18, carbs: 62, fats: 8, fiber: 4, recipe: "1. Soak bihon noodles in hot water for 5 minutes, drain\n2. Heat oil and sauté garlic and onion\n3. Add chicken and cook until done\n4. Add broth, carrots, and cabbage\n5. Add noodles and soy sauce, toss well and cook until noodles absorb liquid" },
  { name: "Arroz Caldo", ingredients: ["rice","chicken","ginger","egg","garlic","onion","turmeric","broth","fish sauce","oil"], calories: 390, protein: 20, carbs: 54, fats: 8, fiber: 2, recipe: "1. Heat oil and sauté garlic, onion, and ginger\n2. Add chicken and cook until done, shred finely\n3. Return chicken to pot, add rice and broth\n4. Add turmeric and fish sauce, simmer until rice is tender\n5. Beat egg and drizzle into the pot while stirring gently" },
  { name: "Kare-Kare", ingredients: ["oxtail","peanut butter","vegetables","garlic","onion","vinegar","salt","pepper","oil","annatto"], calories: 540, protein: 28, carbs: 52, fats: 22, fiber: 5, recipe: "1. Boil oxtail in water with salt and pepper until tender\n2. In a separate pot, sauté garlic, onion, and annatto in oil\n3. Add peanut butter and reserved broth to make sauce\n4. Add vegetables (eggplant, squash, long beans, bok choy)\n5. Simmer until vegetables are cooked, add vinegar to taste" },
  { name: "Lumpiang Sariwa", ingredients: ["spring roll wrapper","vegetables","peanut sauce","garlic","shrimp","pork","egg","vinegar"], calories: 260, protein: 8, carbs: 38, fats: 8, fiber: 4, recipe: "1. Blanch vegetables (cabbage, carrots, green beans) until crisp-tender\n2. Cook pork and shrimp, chop finely\n3. Mix cooked vegetables with pork and shrimp\n4. Place filling on spring roll wrapper, roll tightly and seal\n5. Serve with peanut sauce (peanut butter + vinegar + garlic)" },
  { name: "Daing na Bangus", ingredients: ["milkfish","vinegar","garlic","salt","pepper","bay leaves","cooking oil"], calories: 410, protein: 32, carbs: 44, fats: 10, fiber: 2, recipe: "1. Mix vinegar, salt, pepper, bay leaves, and garlic in a bowl\n2. Place milkfish in a glass dish and pour vinegar mixture over it\n3. Refrigerate for at least 2 hours (preferably overnight)\n4. Heat oil in a pan and fry the marinated milkfish until golden\n5. Serve with the remaining marinade as sauce" },
  { name: "Chicken Inasal", ingredients: ["chicken leg","annatto oil","vinegar","garlic","ginger","brown sugar","salt","pepper"], calories: 420, protein: 34, carbs: 44, fats: 10, fiber: 2, recipe: "1. Mix annatto oil, vinegar, garlic, ginger, brown sugar, salt, and pepper\n2. Marinate chicken legs in this mixture for 1 hour\n3. Grill chicken over charcoal or pan-fry on medium heat\n4. Baste with marinade while grilling until cooked through\n5. Serve with sliced calamansi or lime" },
  { name: "Ginisang Monggo", ingredients: ["mung beans","garlic","pork bits","spinach","onion","ginger","tomato","oil","salt"], calories: 340, protein: 18, carbs: 44, fats: 8, fiber: 6, recipe: "1. Boil mung beans until soft, drain\n2. Heat oil and sauté garlic, onion, and ginger\n3. Add pork bits and cook until done\n4. Add cooked mung beans and simmer for 5 minutes\n5. Add spinach and tomato, cook until spinach wilts, season with salt" },
  { name: "La Paz Batchoy", ingredients: ["egg noodles","pork","chicken liver","egg","garlic","onion","carrots","broth","lard"], calories: 480, protein: 22, carbs: 60, fats: 14, fiber: 2, recipe: "1. Cook egg noodles and set aside\n2. Heat lard and sauté garlic, onion, and carrots\n3. Add pork and chicken liver, simmer until cooked\n4. Pour in broth and bring to a boil\n5. Place noodles in bowl, pour broth and toppings, top with raw egg" },
  { name: "Bicol Express", ingredients: ["pork","coconut milk","long chili","shrimp paste","garlic","onion","salt","oil"], calories: 520, protein: 24, carbs: 52, fats: 22, fiber: 3, recipe: "1. Heat oil and sauté garlic and onion\n2. Add shrimp paste and cook for 1 minute\n3. Add pork cubes and brown on all sides\n4. Pour in coconut milk and add long chili\n5. Simmer for 20 minutes until pork is tender, season with salt" },
  { name: "Paksiw na Bangus", ingredients: ["milkfish","vinegar","eggplant","salt","garlic","ginger","bay leaves","oil"], calories: 380, protein: 28, carbs: 40, fats: 10, fiber: 4, recipe: "1. Layer eggplant slices in a pan with milkfish on top\n2. Mix vinegar, salt, garlic, ginger, and bay leaves, pour over fish\n3. Add oil and bring to a simmer\n4. Cover and cook for 10 minutes until fish is cooked\n5. Serve in a shallow dish with the broth" },
  { name: "Bulalo", ingredients: ["beef shank","corn","radish","spinach","cabbage","garlic","onion","fish sauce","broth"], calories: 520, protein: 32, carbs: 50, fats: 18, fiber: 3, recipe: "1. Boil beef shank with garlic and onion for 45 minutes until tender\n2. Add radish cubes and simmer for 10 minutes\n3. Add corn and cabbage, simmer for 5 minutes\n4. Add spinach and fish sauce\n5. Cook until spinach wilts (2 minutes), season and serve hot" },
  { name: "Tinolang Isda", ingredients: ["fish","ginger","papaya","malunggay leaves","garlic","onion","fish sauce","broth","oil"], calories: 350, protein: 28, carbs: 38, fats: 8, fiber: 3, recipe: "1. Heat oil and sauté ginger, garlic, and onion\n2. Add fish and cook briefly on both sides\n3. Pour in broth and add papaya cubes\n4. Simmer for 8 minutes until papaya is tender\n5. Add malunggay leaves and fish sauce, cook for 2 minutes" },
  { name: "Pochero", ingredients: ["pork","plantains","chickpeas","carrots","potatoes","cabbage","garlic","onion","broth"], calories: 500, protein: 28, carbs: 54, fats: 16, fiber: 5, recipe: "1. Boil pork with garlic and onion until partially cooked\n2. Add potatoes, carrots, and plantains\n3. Simmer for 10 minutes\n4. Add cabbage and chickpeas\n5. Continue cooking until all vegetables are tender (10 minutes)" },
];

// Filipino Snacks List - SPECIFICALLY for snack1 and snack2
const filipinoSnacks = [
  { name: "Banana Cue", ingredients: ["saba banana","brown sugar","cooking oil","salt"], calories: 180, protein: 1, carbs: 35, fats: 5, fiber: 2, recipe: "1. Peel saba bananas and cut in half lengthwise\n2. Heat oil in a pan to medium heat\n3. Add brown sugar and stir until melted\n4. Coat each banana half in the caramelized sugar\n5. Serve hot on a stick with pinch of salt" },
  { name: "Camote Cue", ingredients: ["sweet potato","brown sugar","cooking oil","salt"], calories: 160, protein: 1, carbs: 32, fats: 4, fiber: 3, recipe: "1. Peel and cut sweet potato into thick lengthwise pieces\n2. Heat oil in a pan over medium heat\n3. Melt brown sugar in the oil until bubbly\n4. Dip each sweet potato piece in the caramelized sugar\n5. Skewer and serve immediately while warm" },
  { name: "Fishball", ingredients: ["fish meat","cornstarch","salt","pepper","garlic","vinegar"], calories: 120, protein: 10, carbs: 12, fats: 3, fiber: 0, recipe: "1. Grind fish meat finely with salt, pepper, and minced garlic\n2. Mix in cornstarch to bind the mixture\n3. Shape into small balls (about 1 inch diameter)\n4. Boil in water until balls float and rise to top\n5. Serve with vinegar-garlic dipping sauce" },
  { name: "Siomai", ingredients: ["pork","shrimp","wonton wrapper","soy sauce","ginger","garlic"], calories: 140, protein: 8, carbs: 14, fats: 5, fiber: 0, recipe: "1. Mince pork and shrimp together finely\n2. Mix with grated ginger, minced garlic, and soy sauce\n3. Place 1 teaspoon filling on wonton wrapper\n4. Gather corners at top and seal\n5. Steam for 10-12 minutes until wrapper is translucent" },
  { name: "Lumpia Shanghai", ingredients: ["pork","cabbage","carrots","spring roll wrapper","garlic","onion","soy sauce"], calories: 150, protein: 7, carbs: 16, fats: 6, fiber: 1, recipe: "1. Sauté garlic and onion, add minced pork and cook until done\n2. Add shredded cabbage and carrots, cook until soft\n3. Season with soy sauce and cool mixture\n4. Fill each spring roll wrapper with 2 tablespoons filling\n5. Roll tightly and deep fry until golden brown" },
  { name: "Turon", ingredients: ["banana","brown sugar","spring roll wrapper","cooking oil","cinnamon"], calories: 170, protein: 1, carbs: 32, fats: 5, fiber: 2, recipe: "1. Slice saba banana lengthwise into strips\n2. Place banana slice and brown sugar on spring roll wrapper\n3. Sprinkle cinnamon and roll tightly, sealing edges with water\n4. Deep fry in oil until wrapper is golden and crispy\n5. Drain on paper towel and serve hot" },
  { name: "Halo-Halo", ingredients: ["ice","evaporated milk","mango","jackfruit","palm seeds","red beans","vanilla ice cream"], calories: 220, protein: 3, carbs: 45, fats: 4, fiber: 3, recipe: "1. Layer shaved ice in a tall glass\n2. Add cooked red beans and palm seeds\n3. Top with diced mango and jackfruit\n4. Pour evaporated milk over the mixture\n5. Top with a scoop of vanilla ice cream and serve immediately" },
  { name: "Bibingka", ingredients: ["rice flour","coconut","brown sugar","egg","baking powder","salt","butter"], calories: 240, protein: 4, carbs: 38, fats: 8, fiber: 1, recipe: "1. Mix rice flour, brown sugar, baking powder, and salt\n2. Beat egg and combine with coconut milk and flour mixture\n3. Pour into buttered banana leaves on hot skillet\n4. Cook on medium heat with charcoal on top for 8-10 minutes\n5. Cool slightly, serve with grated coconut" },
  { name: "Puto", ingredients: ["rice flour","sugar","baking powder","salt","egg","milk","banana leaves"], calories: 180, protein: 3, carbs: 36, fats: 2, fiber: 1, recipe: "1. Mix rice flour, sugar, baking powder, and salt together\n2. Beat egg and combine with milk, then mix with dry ingredients\n3. Fill small molds or cups lined with banana leaves\n4. Steam in a steamer basket for 8-10 minutes\n5. Cool and remove from molds to serve" },
  { name: "Balut", ingredients: ["duck egg","salt","vinegar","ginger"], calories: 190, protein: 14, carbs: 1, fats: 14, fiber: 0, recipe: "1. Boil duck eggs in salted water for 15-20 minutes\n2. Gently crack open the shell at the wider end\n3. Sip the broth from inside the egg\n4. Eat the cooked embryo and yolk inside\n5. Serve with salt, vinegar, and ginger sauce for dipping" },
  { name: "Kwek-Kwek", ingredients: ["quail eggs","flour","turmeric","salt","baking powder","oil"], calories: 130, protein: 7, carbs: 12, fats: 5, fiber: 0, recipe: "1. Hard boil quail eggs and peel carefully\n2. Make batter: mix flour, turmeric, salt, baking powder with water\n3. Heat oil for deep frying\n4. Coat each quail egg in batter and deep fry until golden\n5. Serve with sweet and spicy vinegar sauce" },
  { name: "Tokneneng", ingredients: ["quail eggs","flour","turmeric","sweet chili sauce","oil","vinegar"], calories: 150, protein: 8, carbs: 14, fats: 6, fiber: 0, recipe: "1. Hard boil quail eggs and peel completely\n2. Prepare turmeric batter (flour, turmeric, salt, water)\n3. Skewer 3-4 quail eggs on a stick\n4. Dip in batter and deep fry until golden\n5. Coat with sweet chili sauce and serve with vinegar" },
  { name: "Empanada", ingredients: ["flour","butter","meat","potatoes","garlic","onion","egg"], calories: 240, protein: 8, carbs: 28, fats: 10, fiber: 2, recipe: "1. Cook minced meat with garlic, onion, and diced potatoes\n2. Season with salt and pepper, cool the filling\n3. Make dough: flour, butter, salt, and water kneaded together\n4. Roll dough thin, cut circles, fill, and fold\n5. Deep fry until golden brown on both sides" },
  { name: "Puto Bumbong", ingredients: ["rice flour","coconut milk","brown sugar","salt","banana leaves"], calories: 210, protein: 2, carbs: 40, fats: 5, fiber: 2, recipe: "1. Mix rice flour, brown sugar, salt, and coconut milk\n2. Pour into bamboo tubes (bumbong) lined with banana leaves\n3. Steam in boiling water for 15 minutes\n4. Push puto out of tube onto banana leaf\n5. Serve hot topped with grated coconut and brown sugar" },
  { name: "Tinutuan", ingredients: ["rice","chicken","ginger","egg","garlic","onion","fish sauce"], calories: 200, protein: 8, carbs: 28, fats: 4, fiber: 1, recipe: "1. Cook shredded chicken with garlic and onion\n2. Add broth and bring to boil, then add rice\n3. Add ginger slices and simmer until rice is very soft\n4. Stir in fish sauce and pour into bowl\n5. Top with fried egg and crispy garlic bits" },
  { name: "Lumpiang Togue", ingredients: ["bean sprouts","pork","spring roll wrapper","garlic","onion","soy sauce"], calories: 140, protein: 7, carbs: 16, fats: 4, fiber: 2, recipe: "1. Sauté garlic and onion, add minced pork and cook until done\n2. Add bean sprouts and soy sauce, cook for 2 minutes\n3. Let filling cool slightly\n4. Roll in spring roll wrapper tightly\n5. Deep fry until golden brown and crispy" },
  { name: "Okoy", ingredients: ["shrimp","potato","flour","egg","onion","oil","vinegar"], calories: 180, protein: 8, carbs: 20, fats: 7, fiber: 2, recipe: "1. Shred potato and squeeze out excess moisture\n2. Mix with chopped shrimp, onion, flour, and beaten egg\n3. Season with salt and pepper\n4. Drop spoonfuls into hot oil for deep frying\n5. Fry until golden on both sides, serve with vinegar sauce" },
  { name: "Cassava Cake", ingredients: ["cassava","coconut milk","sugar","egg","butter","salt"], calories: 250, protein: 2, carbs: 42, fats: 8, fiber: 2, recipe: "1. Grate fresh cassava finely\n2. Mix cassava with coconut milk, sugar, egg, butter, and salt\n3. Pour into greased baking pan\n4. Bake at 350°F for 35-40 minutes until golden\n5. Cool before cutting into squares" },
  { name: "Ube Cake", ingredients: ["ube","flour","sugar","egg","butter","baking powder","milk"], calories: 260, protein: 4, carbs: 44, fats: 8, fiber: 1, recipe: "1. Steam and mash ube yam until smooth\n2. Cream together butter and sugar\n3. Add egg, ube puree, and flour alternately with milk\n4. Add baking powder and mix until smooth\n5. Bake in greased pan at 350°F for 30-35 minutes" },
  { name: "Choco Pie", ingredients: ["graham crackers","chocolate","condensed milk","butter","salt"], calories: 210, protein: 2, carbs: 32, fats: 9, fiber: 1, recipe: "1. Crush graham crackers into fine crumbs\n2. Melt butter and mix with crushed graham and salt\n3. Press into pie crust and refrigerate\n4. Melt chocolate with condensed milk for filling\n5. Pour into crust and refrigerate until set" },
  { name: "Dilis (Dried Anchovies)", ingredients: ["anchovies","salt"], calories: 120, protein: 20, carbs: 0, fats: 4, fiber: 0, recipe: "1. Clean fresh anchovies under running water\n2. Remove heads and gut if desired (optional)\n3. Layer on trays with sea salt between layers\n4. Dry under sun for 3-5 days until completely dried\n5. Store in airtight container for long-term use" },
  { name: "Bagnet Bits", ingredients: ["pork belly","salt","garlic"], calories: 280, protein: 16, carbs: 0, fats: 23, fiber: 0, recipe: "1. Cut pork belly into small cubes about 1 inch\n2. Boil in water with salt and garlic for 10 minutes\n3. Drain well and dry completely\n4. Deep fry in oil over low heat until golden and crispy\n5. Drain on paper towel, serve as a crispy pork cracklings" },
  { name: "Peanut Brittle", ingredients: ["peanuts","brown sugar","corn syrup","butter","salt"], calories: 220, protein: 8, carbs: 28, fats: 10, fiber: 2, recipe: "1. Heat brown sugar, corn syrup, and butter to 300°F\n2. Add roasted peanuts and stir to coat\n3. Quickly pour onto buttered baking sheet\n4. Cool completely then break into pieces\n5. Store in airtight container" },
  { name: "Sweet Corn Ice Cream", ingredients: ["corn","milk","sugar","cream","vanilla"], calories: 180, protein: 4, carbs: 26, fats: 7, fiber: 1, recipe: "1. Blend cooked corn with milk until smooth\n2. Strain through fine mesh to get corn milk\n3. Heat corn milk with sugar until dissolved\n4. Cool completely, add cream and vanilla extract\n5. Churn in ice cream maker according to instructions" },
  { name: "Egg Pie", ingredients: ["egg yolks","pie crust","sugar","condensed milk","evaporated milk"], calories: 240, protein: 6, carbs: 32, fats: 10, fiber: 1, recipe: "1. Beat egg yolks with sugar until pale\n2. Mix in condensed milk and evaporated milk\n3. Pour into unbaked pie crust\n4. Bake at 375°F for 30-35 minutes until set\n5. Cool before slicing and serving" },
  { name: "Fried Spring Roll", ingredients: ["cabbage","carrots","pork","spring roll wrapper","garlic","soy sauce"], calories: 160, protein: 6, carbs: 18, fats: 7, fiber: 2, recipe: "1. Sauté garlic, add minced pork and cook until done\n2. Add shredded cabbage and carrots, season with soy sauce\n3. Cook until vegetables soften, then cool\n4. Wrap in spring roll wrapper, seal edges with water\n5. Deep fry until golden brown and crispy" },
  { name: "Garlic Bread Stick", ingredients: ["bread","garlic","butter","parmesan cheese","salt"], calories: 180, protein: 4, carbs: 24, fats: 8, fiber: 1, recipe: "1. Slice bread into sticks about 1 inch wide\n2. Mix softened butter with minced garlic, salt, and parmesan\n3. Brush garlic butter generously on bread sticks\n4. Arrange on baking sheet and bake at 375°F for 10-12 minutes\n5. Serve hot with additional parmesan cheese" },
];


// ===== AUTHENTICATION MIDDLEWARE =====
interface AuthRequest extends Request {
  user?: any;
}

function getJwtSecret(): string {
  const secret = (process.env.JWT_SECRET || '').trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'development') return 'dev_jwt_secret_change_me';
  // In production, require explicit secret.
  throw new Error('JWT_SECRET is not configured');
}

const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];


  if (!token) {
    return res.status(401).json({ 
      success: false,
      message: 'Access token required' 
    });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    // Attach decoded data first
    req.user = decoded;

    try {
      // Fetch latest user status from DB to enforce inactive/disabled states
      const [rows] = await pool.query<any>(`SELECT id, status, payment_status, subscription_end, grace_until FROM users WHERE id = ? LIMIT 1`, [decoded.id]);
      const dbUser = rows?.[0];
      if (dbUser) {
        const role = String(decoded?.role || req.user?.role || '').toLowerCase();
        if (role === 'member') {
          const toDateOnly = (value: any): Date | null => {
            if (!value) return null;
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return null;
            d.setHours(0, 0, 0, 0);
            return d;
          };

          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const graceUntil = toDateOnly(dbUser.grace_until);
          const subscriptionEnd = toDateOnly(dbUser.subscription_end);
          const expiryBoundary = graceUntil || subscriptionEnd;
          const isPastDue = !!expiryBoundary && expiryBoundary.getTime() < today.getTime();

          if (isPastDue && String(dbUser.status || '').toLowerCase() !== 'inactive') {
            await pool.query(
              `UPDATE users SET status = 'inactive', payment_status = 'expired' WHERE id = ?`,
              [decoded.id]
            );
            dbUser.status = 'inactive';
            dbUser.payment_status = 'expired';
          }
        }

        req.user.status = dbUser.status;
        req.user.paymentStatus = dbUser.payment_status;
        req.user.subscriptionEnd = dbUser.subscription_end;
        req.user.graceUntil = dbUser.grace_until;

        // If the account is inactive/disabled, allow only payment-related endpoints
        const isInactive = String(dbUser.status || '').toLowerCase() === 'inactive';
        const isDisabled = String(dbUser.status || '').toLowerCase() === 'disabled';
        if ((isInactive || isDisabled)) {
          const path = req.path || req.originalUrl || '';
          const allowIfContains = ['payments', 'payment', '/member/payment', '/payment/success', '/payment/failed'];
          const allowed = allowIfContains.some(s => path.includes(s));
          if (!allowed) {
            return res.status(403).json({ success: false, message: 'Account inactive. Please renew to regain access.' });
          }
        }
      }
    } catch (dbErr: any) {
      // If DB check fails, log and continue (do not block token validation)
      console.error('Auth DB check error:', (dbErr as any)?.message || dbErr);
    }

    next();
  } catch (err: any) {
    return res.status(403).json({ 
      success: false,
      message: 'Invalid or expired token' 
    });
  }
};

const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if ((req.user?.role || '') !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
};

async function ensureEquipmentTable() {
  // Prefer PostgreSQL DDL (this backend uses `pg` behind a MySQL-placeholder wrapper).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipment (
        id SERIAL PRIMARY KEY,
        equip_name VARCHAR(255) NOT NULL,
        category VARCHAR(50) NOT NULL DEFAULT 'cardio',
        purchase_date DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'operational' CHECK (status IN ('operational', 'maintenance', 'broken')),
        last_maintenance DATE,
        next_schedule DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_equipment_status ON equipment(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment(category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_equipment_purchase_date ON equipment(purchase_date)`);
    return;
  } catch (err: any) {
    // fall through
  }

  // MySQL fallback for local setups.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipment (
        id INT AUTO_INCREMENT PRIMARY KEY,
        equip_name VARCHAR(255) NOT NULL,
        category VARCHAR(50) NOT NULL DEFAULT 'cardio',
        purchase_date DATE NOT NULL,
        status ENUM('operational','maintenance','broken') NOT NULL DEFAULT 'operational',
        last_maintenance DATE NULL,
        next_schedule DATE NULL,
        notes TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT NOW(),
        updated_at DATETIME NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err: any) {
    logWarn('Failed to ensure equipment table', err?.message || String(err));
  }
}

async function ensureMuscleGainRecordsTable() {
  // Prefer PostgreSQL DDL (this backend uses `pg` behind a MySQL-placeholder wrapper).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS muscle_gain_records (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        record_date DATE NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, record_date)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_muscle_gain_user_date ON muscle_gain_records(user_id, record_date)`);
    return;
  } catch (err: any) {
    // fall through
  }

  // MySQL fallback for local setups.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS muscle_gain_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        record_date DATE NOT NULL,
        data JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT NOW(),
        updated_at DATETIME NOT NULL DEFAULT NOW(),
        UNIQUE KEY uniq_muscle_gain_user_date (user_id, record_date),
        INDEX idx_muscle_gain_user_date (user_id, record_date)
      )
    `);
  } catch (err: any) {
    logWarn('Failed to ensure muscle_gain_records table', err?.message || String(err));
  }
}

async function ensureProgressRecordsTable() {
  // Prefer PostgreSQL DDL (this backend uses `pg` behind a MySQL-placeholder wrapper).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS progress_records (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        record_date DATE NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_progress_user_date ON progress_records(user_id, record_date)`);
    return;
  } catch (err: any) {
    // fall through
  }

  // MySQL fallback for local setups.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS progress_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        record_date DATE NOT NULL,
        data JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT NOW(),
        updated_at DATETIME NOT NULL DEFAULT NOW(),
        INDEX idx_progress_user_date (user_id, record_date)
      )
    `);
  } catch (err: any) {
    logWarn('Failed to ensure progress_records table', err?.message || String(err));
  }
}

async function ensureAbsenceReminderSettingsTable() {
  // Stores per-user reminder settings so they sync across devices.
  // Prefer PostgreSQL DDL (this backend uses `pg` behind a MySQL-placeholder wrapper).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_absence_reminder_settings (
        user_id INT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        threshold_days INT NOT NULL DEFAULT 3,
        reminder_hour INT NOT NULL DEFAULT 8,
        reminder_minute INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    return;
  } catch (err: any) {
    // fall through
  }

  // MySQL fallback for local setups.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_absence_reminder_settings (
        user_id INT PRIMARY KEY,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        threshold_days INT NOT NULL DEFAULT 3,
        reminder_hour INT NOT NULL DEFAULT 8,
        reminder_minute INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT NOW(),
        updated_at DATETIME NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err: any) {
    logWarn('Failed to ensure user_absence_reminder_settings table', err?.message || String(err));
  }
}

// ===== HELPER FUNCTIONS =====

function calculateCaloriesFromMacros(protein: any, carbs: any, fats: any, fallbackCalories = 0): number {
  const p = Number(protein ?? 0);
  const c = Number(carbs ?? 0);
  const f = Number(fats ?? 0);
  const hasMacroData = Number.isFinite(p) || Number.isFinite(c) || Number.isFinite(f);
  if (!hasMacroData) return Number(fallbackCalories || 0);

  const proteinSafe = Number.isFinite(p) ? Math.max(0, p) : 0;
  const carbsSafe = Number.isFinite(c) ? Math.max(0, c) : 0;
  const fatsSafe = Number.isFinite(f) ? Math.max(0, f) : 0;
  return Math.round(proteinSafe * 4 + carbsSafe * 4 + fatsSafe * 9);
}

function caloriesFromMacrosWithFallback(meal: any): number {
  return calculateCaloriesFromMacros(
    meal?.protein ?? meal?.pro,
    meal?.carbs ?? meal?.carb,
    meal?.fats ?? meal?.fat,
    Number(meal?.calories ?? meal?.cal ?? 0)
  );
}

// Add rice/carb sides to lunch and dinner meals
function addRiceSidesToMeals(weekPlan: any[]) {
  const riceSideDishes = [
    { name: 'Sinangag na Kanin (Garlic Fried Rice)', calories: 180, carbs: 35, protein: 4, fats: 2 },
    { name: 'Plain Steamed Rice', calories: 130, carbs: 28, protein: 2.7, fats: 0.3 },
    { name: 'Fried Rice', calories: 160, carbs: 30, protein: 3, fats: 3 }
  ];
  
  return weekPlan.map((day: any) => {
    const updatedMeals = { ...day.meals };
    
    // Add rice to lunch if not already included
    if (updatedMeals.lunch && !String(updatedMeals.lunch.name || '').toLowerCase().includes('rice')) {
      const randomRice = riceSideDishes[Math.floor(Math.random() * riceSideDishes.length)];
      updatedMeals.lunch = {
        ...updatedMeals.lunch,
        name: `${updatedMeals.lunch.name} with ${randomRice.name}`,
        carbs: (updatedMeals.lunch.carbs || 0) + randomRice.carbs,
        protein: (updatedMeals.lunch.protein || 0) + randomRice.protein,
        fats: (updatedMeals.lunch.fats || 0) + randomRice.fats,
        ingredients: Array.isArray(updatedMeals.lunch.ingredients) 
          ? [...updatedMeals.lunch.ingredients, 'Garlic Fried Rice or Steamed Rice'] 
          : ['Garlic Fried Rice or Steamed Rice']
      };
      updatedMeals.lunch.calories = caloriesFromMacrosWithFallback(updatedMeals.lunch);
    }
    
    // Add rice to dinner if not already included
    if (updatedMeals.dinner && !String(updatedMeals.dinner.name || '').toLowerCase().includes('rice')) {
      const randomRice = riceSideDishes[Math.floor(Math.random() * riceSideDishes.length)];
      updatedMeals.dinner = {
        ...updatedMeals.dinner,
        name: `${updatedMeals.dinner.name} with ${randomRice.name}`,
        carbs: (updatedMeals.dinner.carbs || 0) + randomRice.carbs,
        protein: (updatedMeals.dinner.protein || 0) + randomRice.protein,
        fats: (updatedMeals.dinner.fats || 0) + randomRice.fats,
        ingredients: Array.isArray(updatedMeals.dinner.ingredients)
          ? [...updatedMeals.dinner.ingredients, 'Garlic Fried Rice or Steamed Rice']
          : ['Garlic Fried Rice or Steamed Rice']
      };
      updatedMeals.dinner.calories = caloriesFromMacrosWithFallback(updatedMeals.dinner);
    }
    
    // Recalculate totals
    const totals = sumMacros(Object.values(updatedMeals));
    return {
      ...day,
      meals: updatedMeals,
      totalCalories: totals.calories,
      totalProtein: totals.protein,
      totalCarbs: totals.carbs,
      totalFats: totals.fats
    };
  });
}

function scaleMealPortion(meal: any, factor: number) {
  if (!meal || typeof meal !== 'object') return meal;
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) return meal;

  const scaled: any = { ...meal };
  const scaleField = (key: string) => {
    const v = Number((scaled as any)[key] ?? 0);
    if (Number.isFinite(v)) (scaled as any)[key] = Math.round(v * f);
  };

  scaleField('protein');
  scaleField('carbs');
  scaleField('fats');
  scaleField('fiber');
  scaled.calories = caloriesFromMacrosWithFallback(scaled);
  // Keep UI wording simple and consistent.
  scaled.portionSize = '1 serving';

  return scaled;
}

function scaleWeekPlanToCalorieTarget(weekPlan: any[], targets: any) {
  if (!Array.isArray(weekPlan) || weekPlan.length === 0) return weekPlan;

  const desired = Number(targets?.calories);
  if (!Number.isFinite(desired) || desired <= 0) return weekPlan;

  // Keep it realistic-ish; ultra low/high targets will be clamped.
  const desiredClamped = Math.min(5000, Math.max(800, desired));

  return weekPlan.map((day: any) => {
    const meals = day?.meals && typeof day.meals === 'object' ? day.meals : {};
    const totals = sumMacros(Object.values(meals));
    const current = Number(totals.calories || 0);
    if (!Number.isFinite(current) || current <= 0) return day;

    // If already close, don't touch (prevents unnecessary churn).
    const ratioRaw = desiredClamped / current;
    if (Math.abs(1 - ratioRaw) <= 0.08) {
      return day;
    }

    // Clamp scaling to avoid extreme/unrealistic portions.
    const ratio = Math.min(2.2, Math.max(0.6, ratioRaw));

    const scaledMeals: any = {};
    for (const [k, v] of Object.entries(meals)) {
      scaledMeals[k] = scaleMealPortion(v, ratio);
    }

    const scaledTotals = sumMacros(Object.values(scaledMeals));
    return {
      ...day,
      meals: scaledMeals,
      totalCalories: scaledTotals.calories,
      totalProtein: scaledTotals.protein,
      totalCarbs: scaledTotals.carbs,
      totalFats: scaledTotals.fats,
    };
  });
}

async function enhanceAIWeekPlanWithDetails(parsedWeekPlan: any[], dishes: any[]) {
  if (!Array.isArray(parsedWeekPlan)) return [];

  return parsedWeekPlan.map((dayObj: any) => {
    const mealsInput = dayObj.meals || {};
    const enrichedMeals: Record<string, any> = {};

    for (const [mealType, mealValue] of Object.entries(mealsInput)) {
      let mealName = "";
      if (typeof mealValue === "string") {
        mealName = mealValue;
      } else if (mealValue && typeof mealValue === "object") {
        mealName = (mealValue as any).name || "";
      }

      const dish = dishes.find((d: any) => String(d.name || "").toLowerCase() === String(mealName || "").toLowerCase());
      if (dish) {
        let ingredients: string[] = [];
        try {
          if (typeof dish.ingredients === "string") {
            ingredients = JSON.parse(String(dish.ingredients));
            if (!Array.isArray(ingredients)) ingredients = [String(dish.ingredients)];
          } else if (Array.isArray(dish.ingredients)) {
            ingredients = dish.ingredients;
          } else {
            ingredients = [];
          }
        } catch (e: any) {
          ingredients = String(dish.ingredients || "").split(",").map((s: string) => s.trim()).filter(Boolean);
        }

        enrichedMeals[mealType] = {
          name: dish.name,
          ingredients,
          portionSize: dish.portion_size || "1 serving",
          calories: Number(dish.calories ?? dish.cal ?? 0),
          protein: Number(dish.protein ?? dish.pro ?? 0),
          carbs: Number(dish.carbs ?? dish.carb ?? 0),
          fats: Number(dish.fats ?? dish.fat ?? 0),
          fiber: Number(dish.fiber ?? 0),
          recipe: dish.recipe || (mealValue && (mealValue as any).recipe) || ""
        };
      } else {
        if (typeof mealValue === "object" && mealValue !== null) {
          enrichedMeals[mealType] = createMealObject(mealValue);
        } else {
          enrichedMeals[mealType] = createMealObject({ name: mealName || "Unnamed Meal" });
        }
      }
    }

    const totals = sumMacros(Object.values(enrichedMeals));
    return {
      day: dayObj.day || dayObj.dayName || "",
      meals: enrichedMeals,
      totalCalories: totals.calories,
      totalProtein: totals.protein,
      totalCarbs: totals.carbs,
      totalFats: totals.fats,
    };
  });
}

const DEFAULT_RECIPE_TEXT = "1. Gather and measure all ingredients before cooking.\n2. Heat pan/pot over medium heat and start with aromatics.\n3. Add main protein and cook until done, then add liquids/seasonings.\n4. Simmer until flavors develop and texture is correct.\n5. Taste, adjust seasoning, and serve hot.";

const INGREDIENT_MEASUREMENT_REGEX = /\b\d+(?:\.\d+)?\s?(?:kg|g|mg|l|ml|tbsp|tsp|cup|cups|pc|pcs|piece|pieces|clove|cloves|slice|slices)\b/i;

function hasMeasurement(ingredient: string): boolean {
  return INGREDIENT_MEASUREMENT_REGEX.test(String(ingredient || '').toLowerCase());
}

function hasSpecificProteinType(ingredient: string): boolean {
  const s = String(ingredient || '').toLowerCase();
  return /pork|chicken|beef|milkfish|bangus|tilapia|tuna|shrimp|fish|egg|duck|tofu|monggo|mung/i.test(s);
}

function isVagueIngredient(ingredient: string): boolean {
  const s = String(ingredient || '').toLowerCase().trim();
  if (!s) return true;
  if (/^(meat|fish|oil|vegetables?|seasoning|spices?)$/.test(s)) return true;
  if (/\btocino\b/.test(s) && !/pork|chicken|beef/.test(s)) return true;
  if (/\boil\b/.test(s) && !/canola|vegetable|olive|coconut|corn/.test(s)) return true;
  return false;
}

function inferProteinFromMeal(mealName: string): string {
  const m = String(mealName || '').toLowerCase();
  if (m.includes('bangus')) return 'milkfish (bangus)';
  if (m.includes('chicken') || m.includes('manok') || m.includes('tinola')) return 'chicken';
  if (m.includes('beef') || m.includes('tapa') || m.includes('bulalo')) return 'beef';
  if (m.includes('pork') || m.includes('baboy') || m.includes('adobo') || m.includes('tocino')) return 'pork';
  return 'pork';
}

function makeSpecificMeasuredIngredient(ingredient: string, mealName: string): string {
  const raw = String(ingredient || '').trim();
  if (!raw) return '5 g iodized salt';
  const s = raw.toLowerCase();

  if (hasMeasurement(raw) && (!isVagueIngredient(raw) || hasSpecificProteinType(raw))) return raw;

  if (s === 'tocino' || s.includes('tocino')) {
    const protein = inferProteinFromMeal(mealName);
    return `120 g ${protein} tocino`;
  }
  if (s.includes('garlic fried rice or steamed rice')) return '150 g cooked garlic fried rice';
  if (s === 'oil' || s === 'cooking oil' || /\boil\b/.test(s)) return '10 ml canola oil';
  if (s === 'water' || s === 'broth') return s === 'broth' ? '240 ml low-sodium chicken broth' : '240 ml water';
  if (s === 'egg' || s === 'eggs') return '1 large chicken egg (50 g)';
  if (s.includes('rice')) return '150 g cooked white rice';
  if (s.includes('soy sauce') || s === 'toyo') return '15 ml low-sodium soy sauce';
  if (s.includes('vinegar')) return '15 ml cane vinegar';
  if (s.includes('garlic')) return '10 g garlic (2 cloves), minced';
  if (s.includes('onion')) return '50 g onion, sliced';
  if (s.includes('ginger')) return '10 g ginger, sliced';
  if (s === 'meat' || s.includes('meat')) return `120 g lean ${inferProteinFromMeal(mealName)}`;
  if (s === 'fish') return '120 g milkfish (bangus) fillet';
  if (s === 'vegetables' || s === 'veggies') return '120 g mixed vegetables (pechay, carrots, sitaw)';
  if (s === 'salt') return '2 g iodized salt';
  if (s === 'pepper' || s.includes('black pepper')) return '1 g ground black pepper';

  if (hasSpecificProteinType(s)) return `120 g ${raw}`;
  return `30 g ${raw}`;
}

function normalizeDetailedIngredients(ingredients: string[], mealName: string): string[] {
  const list = Array.isArray(ingredients) ? ingredients : [];
  const normalized = list
    .map((item) => makeSpecificMeasuredIngredient(String(item || '').trim(), mealName))
    .map((item) => item.trim())
    .filter(Boolean);

  const deduped = Array.from(new Set(normalized));
  if (deduped.length > 0) return deduped;

  const protein = inferProteinFromMeal(mealName);
  return [
    `120 g lean ${protein}`,
    '10 ml canola oil',
    '50 g onion, sliced',
    '10 g garlic (2 cloves), minced',
    '240 ml water',
  ];
}

function ingredientsNeedUpgrade(ingredients: string[]): boolean {
  if (!Array.isArray(ingredients) || ingredients.length === 0) return true;
  return ingredients.some((ing) => {
    const text = String(ing || '').trim();
    return !text || isVagueIngredient(text) || !hasMeasurement(text);
  });
}

function recipeNeedsUpgrade(recipe: string): boolean {
  const r = String(recipe || '').trim();
  if (!r) return true;
  if (r.includes('traditional Filipino method')) return true;
  const steps = r.split(/\n+/).filter((line) => /^\s*\d+[.)]\s+/.test(line)).length;
  return steps < 4;
}

function createMealObject(meal: any) {
  let ingredients: any = meal?.ingredients ?? meal?.ingredient ?? [];
  if (typeof ingredients === 'string') {
    const raw = ingredients.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          ingredients = parsed;
        } else {
          ingredients = raw.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
        }
      } catch {
        ingredients = raw.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
      }
    } else {
      ingredients = [];
    }
  }
  if (!Array.isArray(ingredients)) ingredients = [];

  const mealName = meal.name || "Unnamed Meal";
  const normalizedIngredients = normalizeDetailedIngredients(ingredients, mealName);
  const protein = Number(meal.protein ?? meal.pro ?? 0);
  const carbs = Number(meal.carbs ?? meal.carb ?? 0);
  const fats = Number(meal.fats ?? meal.fat ?? 0);
  const fallbackCalories = Number(meal.calories ?? meal.cal ?? 0);

  return {
    name: mealName,
    ingredients: normalizedIngredients,
    portionSize: meal.portionSize || "1 serving",
    calories: calculateCaloriesFromMacros(protein, carbs, fats, fallbackCalories),
    protein,
    carbs,
    fats,
    fiber: Number(meal.fiber ?? 0),
    recipe: meal.recipe || DEFAULT_RECIPE_TEXT,
  };
}

type ParsedIngredientQuantity = {
  amount: number;
  unit: string;
  ingredientName: string;
};

function normalizeQuantityUnit(unit: string): { unit: string; multiplier: number } {
  const u = String(unit || '').toLowerCase().trim();
  if (u === 'kg') return { unit: 'g', multiplier: 1000 };
  if (u === 'mg') return { unit: 'g', multiplier: 0.001 };
  if (u === 'l') return { unit: 'ml', multiplier: 1000 };
  if (u === 'pcs' || u === 'piece' || u === 'pieces') return { unit: 'pc', multiplier: 1 };
  if (u === 'cloves') return { unit: 'clove', multiplier: 1 };
  if (u === 'slices') return { unit: 'slice', multiplier: 1 };
  if (u === 'cups') return { unit: 'cup', multiplier: 1 };
  return { unit: u, multiplier: 1 };
}

function parseIngredientQuantity(input: string): ParsedIngredientQuantity | null {
  const text = String(input || '').trim();
  if (!text) return null;

  const measuredMatch = text.match(/^\s*(\d+(?:\.\d+)?)\s*(kg|g|mg|l|ml|tbsp|tsp|cup|cups|pc|pcs|piece|pieces|clove|cloves|slice|slices)\b\s*(.+)$/i);
  if (measuredMatch) {
    const amountRaw = Number(measuredMatch[1]);
    const { unit, multiplier } = normalizeQuantityUnit(measuredMatch[2]);
    const ingredientName = String(measuredMatch[3] || '').trim();
    if (!Number.isFinite(amountRaw) || amountRaw <= 0 || !ingredientName) return null;
    return {
      amount: amountRaw * multiplier,
      unit,
      ingredientName,
    };
  }

  return null;
}

function normalizeIngredientNameForShoppingList(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function backfillSeedDishData(source: any[]) {
  if (!Array.isArray(source)) return;

  source.forEach((dish: any) => {
    if (!dish || typeof dish !== 'object') return;
    const mealName = String(dish.name || 'Meal').trim() || 'Meal';

    let ingredients: string[] = [];
    if (Array.isArray(dish.ingredients)) {
      ingredients = dish.ingredients.map(String);
    } else if (typeof dish.ingredients === 'string') {
      const raw = dish.ingredients.trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            ingredients = parsed.map(String);
          } else {
            ingredients = raw.split(/[\r\n,;]+/).map((s: string) => s.trim()).filter(Boolean);
          }
        } catch {
          ingredients = raw.split(/[\r\n,;]+/).map((s: string) => s.trim()).filter(Boolean);
        }
      }
    }

    dish.ingredients = normalizeDetailedIngredients(ingredients, mealName);
    if (recipeNeedsUpgrade(String(dish.recipe || ''))) {
      dish.recipe = DEFAULT_RECIPE_TEXT;
    }
  });
}

function backfillAllSeedDishes() {
  backfillSeedDishData(trustedFilipinoMealsDetailed);
  backfillSeedDishData(filipinoSnacks);
}

backfillAllSeedDishes();

function generateShoppingList(weekPlan: any[]) {
  const ingredientTotals: Record<string, { byUnit: Record<string, number>; unparsedCount: number }> = {};

  if (!Array.isArray(weekPlan)) return [];

  weekPlan.forEach((day: any) => {
    Object.values(day.meals).forEach((meal: any) => {
      if (meal && Array.isArray(meal.ingredients)) {
        meal.ingredients.forEach((ing: string) => {
          const raw = String(ing || '').trim();
          if (!raw) return;

          const parsed = parseIngredientQuantity(raw);
          if (parsed) {
            const key = normalizeIngredientNameForShoppingList(parsed.ingredientName);
            if (!ingredientTotals[key]) {
              ingredientTotals[key] = { byUnit: {}, unparsedCount: 0 };
            }
            ingredientTotals[key].byUnit[parsed.unit] = (ingredientTotals[key].byUnit[parsed.unit] || 0) + parsed.amount;
            return;
          }

          const fallbackKey = normalizeIngredientNameForShoppingList(raw);
          if (!ingredientTotals[fallbackKey]) {
            ingredientTotals[fallbackKey] = { byUnit: {}, unparsedCount: 0 };
          }
          ingredientTotals[fallbackKey].unparsedCount += 1;
        });
      }
    });
  });

  const shoppingList = Object.entries(ingredientTotals).map(([ingredient, totals]) => {
    const unitParts = Object.entries(totals.byUnit).map(([unit, amount]) => {
      const rounded = unit === 'g' || unit === 'ml' ? Math.round(amount) : Math.round(amount * 10) / 10;
      return `${rounded} ${unit}`;
    });

    if (totals.unparsedCount > 0) {
      unitParts.push(`${totals.unparsedCount} item(s)`);
    }

    return {
      ingredient,
      estimate: unitParts.join(' + ') || '1 item(s)',
    };
  });

  shoppingList.sort((a: any, b: any) => a.ingredient.localeCompare(b.ingredient));
  return shoppingList;
}

function getMealPrepTips(weekPlan: any[]) {
  const tips: string[] = [
    "Batch-cook rice (3-4 servings) and freeze in portion containers.",
    "Roast or grill proteins on one day to use across multiple meals.",
    "Chop vegetables and store them in airtight containers for quick cooking.",
    "Prepare sauces and dressings in a jar to add flavor quickly.",
    "Portion meals in reusable containers labeled by day to speed up reheating and reduce waste."
  ];

  const stewDays = (weekPlan || []).filter((d: any) =>
    Object.values(d.meals).some((m: any) => m.name && /sinigang|tinola|bulalo|pochero/i.test(m.name))
  );
  if (stewDays.length >= 2) {
    tips.push("Make a big batch of broths (sinigang/tinola/bulalo) and freeze in portions for quick lunches/dinners.");
  }

  const friedCount = (weekPlan || []).reduce((acc: number, day: any) => {
    const dayFried = Object.values(day.meals).filter((m: any) => m.name && /fried|crispy|prito|daing|tapa|longganisa|spamsilog/i.test(m.name)).length;
    return acc + dayFried;
  }, 0);
  if (friedCount >= 4) {
    tips.push("For fried items, consider pan-searing instead of deep frying to reduce oil use and cleanup time.");
  }

  return tips;
}

function getNutritionTips(goal: string) {
  const normalizedGoal = (goal || "").toLowerCase();
  switch (normalizedGoal) {
    case "muscle gain":
    case "gain":
      return [
        "Increase protein intake at every meal (aim for 20–40g per meal).",
        "Include a mix of fast-digesting carbs and protein post-workout (e.g., rice + chicken).",
        "Use healthy fats (avocado, coconut, nuts) to increase calorie density."
      ];
    case "weight loss":
    case "loss":
      return [
        "Focus on lean proteins and vegetables to increase satiety.",
        "Reduce portion sizes of calorie-dense foods and favor low-calorie volume foods (leafy greens, broth-based soups).",
        "Avoid sugary beverages and reduce fried foods; use steamed or grilled methods."
      ];
    default:
      return [
        "Balance protein, carbs, and fats throughout the day.",
        "Aim for whole foods and fiber-rich vegetables to maintain steady energy.",
        "Drink plenty of water and keep sodium moderate to reduce water retention."
      ];
  }
}

function shuffleArray<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sumMacros(meals: any[]) {
  const totals = { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 };
  meals.forEach((m: any) => {
    const protein = Number(m.protein || m.pro || 0);
    const carbs = Number(m.carbs || m.carb || 0);
    const fats = Number(m.fats || m.fat || 0);
    totals.protein += protein;
    totals.carbs += carbs;
    totals.fats += fats;
    totals.fiber += Number(m.fiber || 0);
  });
  totals.calories = calculateCaloriesFromMacros(totals.protein, totals.carbs, totals.fats, 0);
  return totals;
}

function recomputeWeekPlanTotals(weekPlan: any[]): any[] {
  if (!Array.isArray(weekPlan)) return [];

  return weekPlan.map((day: any) => {
    const rawMeals = day?.meals && typeof day.meals === 'object' ? day.meals : {};
    const meals = Object.entries(rawMeals).reduce((acc: Record<string, any>, [mealKey, rawMeal]) => {
      const mealObj = rawMeal && typeof rawMeal === 'object' ? { ...(rawMeal as any) } : { name: String(rawMeal || 'Unnamed Meal') };

      const protein = Number(mealObj?.protein ?? mealObj?.pro ?? 0);
      const carbs = Number(mealObj?.carbs ?? mealObj?.carb ?? 0);
      const fats = Number(mealObj?.fats ?? mealObj?.fat ?? 0);

      const proteinSafe = Number.isFinite(protein) ? protein : 0;
      const carbsSafe = Number.isFinite(carbs) ? carbs : 0;
      const fatsSafe = Number.isFinite(fats) ? fats : 0;

      acc[mealKey] = {
        ...mealObj,
        protein: proteinSafe,
        carbs: carbsSafe,
        fats: fatsSafe,
        calories: calculateCaloriesFromMacros(
          proteinSafe,
          carbsSafe,
          fatsSafe,
          Number(mealObj?.calories ?? mealObj?.cal ?? 0)
        ),
      };

      return acc;
    }, {});

    const totals = sumMacros(Object.values(meals));
    return {
      ...day,
      meals,
      totalCalories: totals.calories,
      totalProtein: totals.protein,
      totalCarbs: totals.carbs,
      totalFats: totals.fats,
    };
  });
}

function pickUniqueMeals(source: any[], used: Set<string>, count: number) {
  const mealKey = (meal: any) => String(meal?.name || '').trim().toLowerCase();
  const validSource = Array.isArray(source) ? source.filter((m: any) => !!mealKey(m)) : [];
  let pool = validSource.filter((m: any) => !used.has(mealKey(m)));
  if (pool.length === 0) {
    // Allow repeats only when unique options are exhausted.
    pool = [...validSource];
  }
  const shuffled = shuffleArray(pool);
  const picked = shuffled.slice(0, Math.min(count, shuffled.length));
  picked.forEach((m: any) => used.add(mealKey(m)));
  return picked;
}

function hasFlatMainVariety(weekPlan: any[]): boolean {
  if (!Array.isArray(weekPlan) || weekPlan.length < 3) return false;

  const slots: Array<'breakfast' | 'lunch' | 'dinner'> = ['breakfast', 'lunch', 'dinner'];
  return slots.every((slot) => {
    const names = new Set(
      weekPlan
        .map((d: any) => String(d?.meals?.[slot]?.name || '').trim().toLowerCase())
        .filter(Boolean)
    );
    return names.size <= 1;
  });
}

function normalizeSelectionList(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map(String).map(s => s.trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input
      .split(/[\r\n,;]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
}

const MEAL_FILTER_KEYWORDS_BY_TOKEN: Record<string, string[]> = {
  dairy: ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'gatas', 'kesong', 'keso'],
  dairy_free: ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'gatas', 'kesong', 'keso'],
  egg: ['egg', 'itlog'],
  egg_free: ['egg', 'itlog'],
  fish: ['fish', 'bangus', 'tilapia', 'tuna', 'sardines', 'galunggong'],
  seafood_free: ['fish', 'bangus', 'tilapia', 'tuna', 'sardines', 'galunggong', 'seafood'],
  shellfish: ['shrimp', 'prawn', 'hipon', 'crab', 'alimango', 'alimasag', 'lobster', 'shellfish'],
  shellfish_free: ['shrimp', 'prawn', 'hipon', 'crab', 'alimango', 'alimasag', 'lobster', 'shellfish'],
  peanut: ['peanut', 'mani'],
  tree_nut: ['cashew', 'kasuy', 'almond', 'walnut', 'pistachio', 'hazelnut', 'macadamia', 'pecan', 'nut'],
  nut_free: ['cashew', 'kasuy', 'almond', 'walnut', 'pistachio', 'hazelnut', 'macadamia', 'pecan', 'nut', 'peanut', 'mani'],
  soy: ['soy', 'tofu', 'tokwa', 'soya', 'soy sauce', 'toyo'],
  soy_free: ['soy', 'tofu', 'tokwa', 'soya', 'soy sauce', 'toyo'],
  wheat_gluten: ['wheat', 'gluten', 'flour', 'bread', 'pasta', 'noodle', 'noodles', 'miki', 'pancit', 'bihon', 'misua', 'sotanghon'],
  gluten_free: ['wheat', 'gluten', 'flour', 'bread', 'pasta', 'noodle', 'noodles', 'miki', 'pancit', 'bihon', 'misua', 'sotanghon'],
  sesame: ['sesame'],
  halal: ['pork', 'baboy', 'tocino', 'longganisa', 'liempo', 'bacon', 'ham', 'lard', 'alcohol', 'wine'],
  no_pork: ['pork', 'baboy', 'tocino', 'longganisa', 'liempo', 'bacon', 'ham', 'lard'],
  no_beef: ['beef', 'baka', 'tapa', 'bulalo'],
  no_alcohol: ['alcohol', 'wine', 'beer'],
  no_fried_foods: ['fried', 'crispy', 'deep fry', 'prito', 'bagnet', 'chicharon'],
};

function dishTextForFilter(dish: any): string {
  const name = String(dish?.name || '').toLowerCase();
  const rawIngredients = dish?.ingredients ?? dish?.ingredient ?? dish?.ings ?? '';
  let ingredientsText = '';
  if (Array.isArray(rawIngredients)) {
    ingredientsText = rawIngredients.map(String).join(' ').toLowerCase();
  } else {
    ingredientsText = String(rawIngredients || '').toLowerCase();
  }
  return `${name} ${ingredientsText}`.trim();
}

function filterDishesByTokens<T extends any>(source: T[], tokens: string[]): T[] {
  if (!Array.isArray(source) || source.length === 0) return source;
  const normalizedTokens = (tokens || []).map(t => String(t || '').toLowerCase().trim()).filter(Boolean);
  if (normalizedTokens.length === 0) return source;

  const keywordSets = normalizedTokens
    .map(t => MEAL_FILTER_KEYWORDS_BY_TOKEN[t])
    .filter(Boolean)
    .flat();

  if (!keywordSets || keywordSets.length === 0) return source;

  const filtered = source.filter((dish: any) => {
    const hay = dishTextForFilter(dish);
    // exclude if any keyword matches
    return !keywordSets.some((kw) => hay.includes(String(kw).toLowerCase()));
  });

  return filtered.length > 0 ? filtered : source;
}

function normalizeDietType(input: any): string {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';

  const canonical = raw.replace(/[\s-]+/g, '_');
  const aliases: Record<string, string> = {
    none: '',
    no_specific_diet: '',
    no_diet: '',
  };

  if (aliases.hasOwnProperty(canonical)) {
    return aliases[canonical];
  }
  return canonical;
}

function humanizeDietType(input: any): string {
  const normalized = normalizeDietType(input);
  if (!normalized) return 'None';
  return normalized
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getDietPromptRule(input: any): string {
  switch (normalizeDietType(input)) {
    case 'vegan':
      return 'STRICTLY VEGAN: Exclude all meat, poultry, seafood, eggs, dairy, and animal products. Only plant-based dishes.';
    case 'vegetarian':
      return 'VEGETARIAN: Exclude meat, poultry, and seafood. Eggs and dairy are allowed.';
    case 'low_carb':
      return 'LOW CARB: Prioritize dishes with lower carbohydrates and limit rice, noodles, and starchy sides.';
    case 'low_fat':
      return 'LOW FAT: Prioritize lean proteins and low-oil cooking methods. Minimize fried dishes.';
    case 'keto':
      return 'KETO: Keep carbohydrates very low and prioritize fats plus protein. Exclude rice, bread, noodles, and sugary items.';
    case 'paleo':
      return 'PALEO: Exclude grains, legumes, dairy, and highly processed ingredients.';
    case 'low_sodium':
      return 'LOW SODIUM: Minimize salty condiments and preserved ingredients. Favor fresh herbs, citrus, and natural flavors.';
    case 'high_protein':
      return 'HIGH PROTEIN: Prioritize high-protein dishes and snacks while keeping calories within target.';
    default:
      return '';
  }
}

function filterDishesByDiet<T extends any>(source: T[], dietInput: any): T[] {
  if (!Array.isArray(source) || source.length === 0) return source;
  const diet = normalizeDietType(dietInput);
  if (!diet) return source;

  const hasAnyKeyword = (text: string, keywords: string[]) => keywords.some((k) => text.includes(k));

  const animalKeywords = [
    'pork', 'beef', 'chicken', 'baboy', 'manok', 'tapa', 'longganisa', 'tocino', 'ham', 'bacon',
    'fish', 'bangus', 'tilapia', 'tuna', 'galunggong', 'sardines', 'shrimp', 'hipon', 'prawn',
    'crab', 'lobster', 'seafood', 'alamang', 'bagoong',
  ];
  const dairyKeywords = ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'gatas', 'keso'];
  const eggKeywords = ['egg', 'itlog'];
  const highCarbKeywords = ['rice', 'kanin', 'noodle', 'pasta', 'bread', 'tinapay', 'bihon', 'misua', 'sotanghon', 'pancit', 'sugar', 'sweet'];
  const highFatKeywords = ['fried', 'crispy', 'lechon', 'bagnet', 'chicharon', 'deep fry', 'oil'];
  const highSodiumKeywords = ['soy sauce', 'toyo', 'patis', 'fish sauce', 'bagoong', 'salted', 'processed'];
  const paleoExcludedKeywords = [
    'rice', 'noodle', 'pasta', 'bread', 'flour', 'wheat', 'corn',
    'beans', 'monggo', 'mung', 'lentil', 'soy', 'tofu',
    'milk', 'cheese', 'butter', 'cream', 'yogurt',
  ];

  const filtered = source.filter((dish: any) => {
    const hay = dishTextForFilter(dish);
    const protein = Number(dish?.protein ?? dish?.pro ?? 0);
    const carbs = Number(dish?.carbs ?? dish?.carb ?? 0);
    const fats = Number(dish?.fats ?? dish?.fat ?? 0);
    const hasProtein = Number.isFinite(protein) && protein > 0;
    const hasCarbs = Number.isFinite(carbs) && carbs > 0;
    const hasFats = Number.isFinite(fats) && fats > 0;

    switch (diet) {
      case 'vegan':
        return !hasAnyKeyword(hay, [...animalKeywords, ...dairyKeywords, ...eggKeywords]);
      case 'vegetarian':
        return !hasAnyKeyword(hay, animalKeywords);
      case 'low_carb': {
        if (hasAnyKeyword(hay, highCarbKeywords)) return false;
        if (hasCarbs && carbs > 28) return false;
        return true;
      }
      case 'low_fat': {
        if (hasAnyKeyword(hay, highFatKeywords)) return false;
        if (hasFats && fats > 14) return false;
        return true;
      }
      case 'low_sodium':
        return !hasAnyKeyword(hay, highSodiumKeywords);
      case 'high_protein': {
        if (hasProtein) return protein >= 15;
        return hasAnyKeyword(hay, ['chicken', 'beef', 'pork', 'fish', 'bangus', 'tilapia', 'tuna', 'egg', 'itlog', 'tofu', 'monggo']);
      }
      case 'keto': {
        if (hasAnyKeyword(hay, highCarbKeywords)) return false;
        if (hasCarbs && carbs > 12) return false;
        return !hasAnyKeyword(hay, ['sugar', 'sweet']);
      }
      case 'paleo':
        return !hasAnyKeyword(hay, paleoExcludedKeywords);
      default:
        return true;
    }
  });

  return filtered;
}

function assessDietPoolSufficiency(dishes: any[]): { isInsufficient: boolean; reason: string } {
  if (!Array.isArray(dishes) || dishes.length === 0) {
    return { isInsufficient: true, reason: 'No compatible dishes available after diet filtering' };
  }

  const mains = dishes.filter((d: any) => normalizeDishCategory(d?.category) !== 'snacks');
  const snacks = dishes.filter((d: any) => normalizeDishCategory(d?.category) === 'snacks');
  const breakfast = dishes.filter((d: any) => normalizeDishCategory(d?.category) === 'breakfast');
  const lunch = dishes.filter((d: any) => normalizeDishCategory(d?.category) === 'lunch');
  const dinner = dishes.filter((d: any) => normalizeDishCategory(d?.category) === 'dinner');
  const hasExplicitCategories = dishes.some((d: any) => ['breakfast', 'lunch', 'dinner', 'snacks'].includes(normalizeDishCategory(d?.category)));

  const reasons: string[] = [];
  if (mains.length < 5) reasons.push('limited main dishes');
  if (snacks.length < 2) reasons.push('limited snacks');
  if (dishes.length < 8) reasons.push('overall dish pool too small');
  if (hasExplicitCategories) {
    if (breakfast.length === 0) reasons.push('no breakfast dishes');
    if (lunch.length === 0) reasons.push('no lunch dishes');
    if (dinner.length === 0) reasons.push('no dinner dishes');
  }

  return {
    isInsufficient: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join(', ') : 'sufficient',
  };
}

function buildDietFallbackMeal(
  mealSlot: string,
  dietInput: any,
  desiredCalories: number,
  restrictionTokens: string[] = []
) {
  const diet = normalizeDietType(dietInput);
  const slotRaw = String(mealSlot || '').toLowerCase().trim();
  const slot = slotRaw === 'snack1' || slotRaw === 'snack2' || slotRaw === 'snacks' ? 'snacks' : slotRaw;

  const templatesByDiet: Record<string, { mains: any[]; snacks: any[] }> = {
    high_protein: {
      mains: [
        {
          name: 'High-Protein Chicken Tinola Bowl',
          ingredients: ['180 g chicken breast, skinless', '120 g sayote, sliced', '60 g malunggay leaves', '8 g garlic, minced', '12 g ginger, sliced', '400 ml water'],
          protein: 44,
          carbs: 16,
          fats: 10,
          recipe: '1. Saute garlic and ginger for 1 minute.\n2. Add chicken breast and cook for 3 to 4 minutes.\n3. Pour water and simmer until chicken is tender.\n4. Add sayote and cook for 6 minutes.\n5. Add malunggay, cook 1 minute, then serve warm.'
        },
        {
          name: 'Lean Beef and Vegetable Stir-Fry',
          ingredients: ['160 g lean beef strips', '120 g broccoli florets', '80 g bell peppers', '8 g garlic, minced', '10 ml canola oil', '10 ml calamansi juice'],
          protein: 40,
          carbs: 14,
          fats: 13,
          recipe: '1. Heat oil and saute garlic for 30 seconds.\n2. Add lean beef and sear for 3 to 4 minutes.\n3. Add broccoli and bell peppers with a splash of water.\n4. Cook until vegetables are tender-crisp.\n5. Finish with calamansi juice and serve.'
        }
      ],
      snacks: [
        {
          name: 'Egg and Papaya Protein Snack',
          ingredients: ['2 large hard-boiled eggs (100 g)', '120 g ripe papaya cubes'],
          protein: 14,
          carbs: 16,
          fats: 10,
          recipe: '1. Boil eggs for 10 minutes then peel.\n2. Slice eggs and papaya into bite-sized pieces.\n3. Serve immediately as a quick snack.'
        }
      ]
    },
    low_carb: {
      mains: [
        {
          name: 'Grilled Chicken with Ensaladang Pipino',
          ingredients: ['170 g chicken thigh, skinless', '140 g cucumber, sliced', '60 g tomato, chopped', '20 g onion, sliced', '10 ml calamansi juice', '8 ml olive oil'],
          protein: 36,
          carbs: 12,
          fats: 14,
          recipe: '1. Season chicken and grill over medium heat until cooked through.\n2. Mix cucumber, tomato, onion, and calamansi juice.\n3. Drizzle olive oil over the salad.\n4. Serve grilled chicken with fresh salad.'
        },
        {
          name: 'Pechay and Tofu Garlic Saute',
          ingredients: ['150 g firm tofu, cubed', '180 g pechay', '10 g garlic, minced', '10 ml canola oil', '30 ml water', '5 ml calamansi juice'],
          protein: 22,
          carbs: 13,
          fats: 12,
          recipe: '1. Pan-sear tofu in half the oil until lightly golden.\n2. Saute garlic in remaining oil.\n3. Add pechay and water, then cook for 2 to 3 minutes.\n4. Add tofu back and finish with calamansi juice.'
        }
      ],
      snacks: [
        {
          name: 'Cucumber and Egg Low-Carb Snack',
          ingredients: ['1 large hard-boiled egg (50 g)', '150 g cucumber sticks'],
          protein: 8,
          carbs: 5,
          fats: 5,
          recipe: '1. Slice hard-boiled egg and cucumber sticks.\n2. Serve chilled for a light low-carb snack.'
        }
      ]
    },
    low_fat: {
      mains: [
        {
          name: 'Poached Fish with Steamed Vegetables',
          ingredients: ['170 g tilapia fillet', '120 g carrots, sliced', '120 g cabbage, chopped', '8 g garlic, minced', '420 ml water', '8 ml calamansi juice'],
          protein: 34,
          carbs: 18,
          fats: 7,
          recipe: '1. Bring water and garlic to a gentle simmer.\n2. Add fish and poach for 8 minutes.\n3. Steam carrots and cabbage until tender.\n4. Serve fish with vegetables and calamansi juice.'
        },
        {
          name: 'Chicken and Sayote Light Guisado',
          ingredients: ['150 g chicken breast, sliced', '180 g sayote, sliced', '60 g onion', '8 g garlic', '6 ml canola oil', '200 ml water'],
          protein: 33,
          carbs: 17,
          fats: 8,
          recipe: '1. Saute garlic and onion in minimal oil.\n2. Add chicken breast and cook until lightly browned.\n3. Add sayote and water, then simmer 6 to 8 minutes.\n4. Serve warm.'
        }
      ],
      snacks: [
        {
          name: 'Banana and Kamote Light Snack',
          ingredients: ['90 g boiled sweet potato', '100 g banana slices'],
          protein: 2,
          carbs: 38,
          fats: 1,
          recipe: '1. Boil sweet potato until fork-tender and slice.\n2. Serve with fresh banana slices.'
        }
      ]
    },
    low_sodium: {
      mains: [
        {
          name: 'Herb Chicken with Kalabasa and Sitaw',
          ingredients: ['170 g chicken breast, skinless', '140 g kalabasa cubes', '100 g sitaw', '10 g garlic', '12 g onion', '6 ml olive oil'],
          protein: 38,
          carbs: 20,
          fats: 9,
          recipe: '1. Saute garlic and onion in olive oil.\n2. Add chicken and cook for 4 minutes.\n3. Add kalabasa and sitaw with a splash of water.\n4. Simmer until vegetables are tender and chicken is done.\n5. Season with herbs and calamansi instead of salty condiments.'
        },
        {
          name: 'Fresh Tuna and Tomato Guisado',
          ingredients: ['160 g fresh tuna cubes', '140 g tomatoes, chopped', '80 g pechay', '10 g garlic', '8 ml canola oil', '10 ml calamansi juice'],
          protein: 36,
          carbs: 12,
          fats: 10,
          recipe: '1. Saute garlic in oil for 30 seconds.\n2. Add fresh tuna and cook for 3 minutes.\n3. Add tomatoes and pechay, then cook until soft.\n4. Finish with calamansi juice and serve.'
        }
      ],
      snacks: [
        {
          name: 'Papaya and Oats Low-Sodium Cup',
          ingredients: ['120 g papaya cubes', '35 g rolled oats', '180 ml water', '2 g cinnamon powder'],
          protein: 5,
          carbs: 30,
          fats: 3,
          recipe: '1. Cook oats in water over low heat for 5 minutes.\n2. Top with papaya cubes and cinnamon.\n3. Serve warm.'
        }
      ]
    },
    vegetarian: {
      mains: [
        {
          name: 'Ginisang Monggo with Malunggay',
          ingredients: ['140 g cooked mung beans', '60 g malunggay leaves', '80 g tomatoes', '10 g garlic', '60 g onion', '8 ml canola oil'],
          protein: 20,
          carbs: 34,
          fats: 9,
          recipe: '1. Saute garlic and onion in oil until fragrant.\n2. Add tomatoes and cook until soft.\n3. Add cooked mung beans and simmer for 4 minutes.\n4. Stir in malunggay and cook for 1 minute before serving.'
        },
        {
          name: 'Tofu and Mixed Vegetable Stir-Fry',
          ingredients: ['170 g firm tofu, cubed', '80 g carrots, sliced', '90 g cabbage, chopped', '70 g bell peppers', '10 g garlic', '8 ml canola oil'],
          protein: 24,
          carbs: 20,
          fats: 11,
          recipe: '1. Pan-sear tofu until lightly golden.\n2. Saute garlic and add vegetables.\n3. Return tofu to pan and stir-fry for 2 to 3 minutes.\n4. Serve hot.'
        }
      ],
      snacks: [
        {
          name: 'Kamote and Banana Vegetarian Snack',
          ingredients: ['120 g boiled sweet potato', '100 g banana slices'],
          protein: 2,
          carbs: 42,
          fats: 1,
          recipe: '1. Boil sweet potato until tender and slice.\n2. Pair with banana slices and serve.'
        }
      ]
    },
    default: {
      mains: [
        {
          name: 'Balanced Chicken Adobo Bowl',
          ingredients: ['160 g chicken thigh, skinless', '110 g cooked rice', '80 g carrots', '60 g pechay', '8 g garlic', '8 ml canola oil'],
          protein: 34,
          carbs: 30,
          fats: 11,
          recipe: '1. Saute garlic in oil and add chicken.\n2. Cook chicken until lightly browned.\n3. Add vegetables and a little water, then simmer until tender.\n4. Serve with cooked rice.'
        }
      ],
      snacks: [
        {
          name: 'Fruit and Oat Snack Cup',
          ingredients: ['35 g rolled oats', '180 ml water', '100 g banana slices', '80 g papaya cubes'],
          protein: 5,
          carbs: 36,
          fats: 3,
          recipe: '1. Cook oats in water over low heat for 5 minutes.\n2. Top with banana and papaya.\n3. Serve warm.'
        }
      ]
    }
  };

  const selected = templatesByDiet[diet] || templatesByDiet.default;
  const sourceTemplates = slot === 'snacks' ? selected.snacks : selected.mains;

  let candidateTemplates = filterDishesByTokens(sourceTemplates, restrictionTokens);
  candidateTemplates = filterDishesByDiet(candidateTemplates, diet);
  if (!Array.isArray(candidateTemplates) || candidateTemplates.length === 0) {
    candidateTemplates = sourceTemplates;
  }

  const indexSeed = slot === 'breakfast' ? 0 : slot === 'lunch' ? 1 : slot === 'dinner' ? 2 : 3;
  const picked = candidateTemplates[indexSeed % candidateTemplates.length] || sourceTemplates[0];

  const fallbackTarget = Number.isFinite(Number(desiredCalories)) && Number(desiredCalories) > 0
    ? Number(desiredCalories)
    : (slot === 'snacks' ? 220 : 420);
  const currentCalories = calculateCaloriesFromMacros(picked.protein, picked.carbs, picked.fats, 0);
  const ratioRaw = currentCalories > 0 ? (fallbackTarget / currentCalories) : 1;
  const ratio = Math.min(1.8, Math.max(0.7, ratioRaw));

  return createMealObject({
    ...picked,
    protein: Math.round(Number(picked.protein || 0) * ratio),
    carbs: Math.round(Number(picked.carbs || 0) * ratio),
    fats: Math.round(Number(picked.fats || 0) * ratio),
    calories: Math.round(Number(currentCalories || fallbackTarget) * ratio),
    portionSize: '1 serving',
  });
}

function humanizeTokens(tokens: string[]): string {
  const map: Record<string, string> = {
    dairy: 'Dairy',
    egg: 'Egg',
    fish: 'Fish',
    shellfish: 'Shellfish',
    peanut: 'Peanuts',
    tree_nut: 'Tree nuts',
    soy: 'Soy',
    wheat_gluten: 'Wheat/Gluten',
    sesame: 'Sesame',
    gluten_free: 'Gluten-free',
    dairy_free: 'Dairy-free',
    egg_free: 'Egg-free',
    nut_free: 'Nut-free',
    soy_free: 'Soy-free',
    seafood_free: 'Seafood-free',
    shellfish_free: 'Shellfish-free',
    low_sodium: 'Low sodium',
    low_sugar: 'Low sugar',
    halal: 'Halal',
    no_pork: 'No pork',
    no_beef: 'No beef',
    no_alcohol: 'No alcohol',
    no_fried_foods: 'No fried foods',
    budget_friendly: 'Budget-friendly',
  };
  const uniq = Array.from(new Set((tokens || []).map(t => String(t || '').trim()).filter(Boolean)));
  if (uniq.length === 0) return 'none';
  return uniq.map(t => map[t] || t).join(', ');
}

function normalizeDishCategory(raw: any): string {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return '';
  if (s === 'snack' || s === 'snacks' || s.includes('snack')) return 'snacks';
  if (s === 'breakfast' || s.includes('breakfast')) return 'breakfast';
  if (s === 'lunch' || s.includes('lunch')) return 'lunch';
  if (s === 'dinner' || s.includes('dinner')) return 'dinner';
  return s;
}

function generateWeekPlan(
  aiDay: any | null,
  targets: any,
  goal: string,
  restrictionTokens: string[] = [],
  dishesSource?: any[],
  dietType: string = ''
) {
  const toFiniteNumber = (value: any, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
  const dishCalories = (dish: any) => calculateCaloriesFromMacros(
    dish?.protein ?? dish?.pro,
    dish?.carbs ?? dish?.carb,
    dish?.fats ?? dish?.fat,
    toFiniteNumber(dish?.calories ?? dish?.cal ?? 0, 0)
  );
  const mealKey = (dish: any) => String(dish?.name || '').trim().toLowerCase();

  const pickUniqueClosestCalories = (
    source: any[],
    usedSet: Set<string>,
    desiredCalories: number,
    avoidSet: Set<string> = new Set<string>()
  ) => {
    if (!Array.isArray(source) || source.length === 0) return null;

    const validSource = source.filter((m: any) => !!mealKey(m));
    if (validSource.length === 0) return null;

    const notUsedNotAvoided = validSource.filter((m: any) => !usedSet.has(mealKey(m)) && !avoidSet.has(mealKey(m)));
    const notAvoided = validSource.filter((m: any) => !avoidSet.has(mealKey(m)));
    const notUsed = validSource.filter((m: any) => !usedSet.has(mealKey(m)));

    let pool = notUsedNotAvoided;
    if (pool.length === 0) {
      // Fallback order: keep no-immediate-repeat first, then no-global-repeat, then any.
      pool = notAvoided.length > 0 ? notAvoided : (notUsed.length > 0 ? notUsed : validSource);
    }
    if (pool.length === 0) return null;

    const withCalories = pool.filter((m: any) => dishCalories(m) > 0);
    const candidates = withCalories.length > 0 ? withCalories : pool;

    let best = candidates[0];
    let bestDiff = Math.abs(dishCalories(best) - desiredCalories);
    for (const m of candidates) {
      const diff = Math.abs(dishCalories(m) - desiredCalories);
      if (diff < bestDiff) {
        best = m;
        bestDiff = diff;
      }
    }

    usedSet.add(mealKey(best));
    return best;
  };

  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const used = new Set<string>();
  const usedSnacks = new Set<string>();
  const weekPlan: any[] = [];

  const hasDbSource = Array.isArray(dishesSource) && dishesSource.length > 0;

  // Best-effort filtering for fallback generation based on allergies/restriction tokens.
  // If DB dishes exist, prefer them (this makes prod behavior clearly DB-driven even without OpenAI).
  const normalizedDietType = normalizeDietType(dietType);
  const mainSourceRaw = hasDbSource ? (dishesSource as any[]) : trustedFilipinoMealsDetailed;
  const mainSourceFilteredByTokens = filterDishesByTokens(mainSourceRaw, restrictionTokens);
  const mainSourceFilteredByDiet = filterDishesByDiet(mainSourceFilteredByTokens, normalizedDietType);
  const mainSourceFiltered = normalizedDietType ? mainSourceFilteredByDiet : mainSourceFilteredByTokens;

  const breakfastPool = mainSourceFiltered.filter((d: any) => normalizeDishCategory(d?.category) === 'breakfast');
  const lunchPool = mainSourceFiltered.filter((d: any) => normalizeDishCategory(d?.category) === 'lunch');
  const dinnerPool = mainSourceFiltered.filter((d: any) => normalizeDishCategory(d?.category) === 'dinner');

  // Some DB rows may not have a category; treat them as generic mains.
  const genericMainPool = mainSourceFiltered.filter((d: any) => normalizeDishCategory(d?.category) !== 'snacks');
  const allMainPool = genericMainPool.length > 0 ? genericMainPool : mainSourceFiltered;

  const dbSnackPool = hasDbSource
    ? mainSourceFiltered.filter((d: any) => normalizeDishCategory(d?.category) === 'snacks')
    : [];
  const snacksSourceRaw = dbSnackPool.length > 0 ? dbSnackPool : filipinoSnacks;
  const snacksPoolByTokens = filterDishesByTokens(snacksSourceRaw, restrictionTokens);
  const snacksPoolByDiet = filterDishesByDiet(snacksPoolByTokens, normalizedDietType);
  const snacksPool = normalizedDietType ? snacksPoolByDiet : snacksPoolByTokens;

  if (aiDay && aiDay.meals) {
    Object.values(aiDay.meals).forEach((m: any) => {
      if (mealKey(m)) used.add(mealKey(m));
    });
  }

  // Targets are best-effort in fallback generation (AI may do better), but we should still
  // try to respect the requested calories so 1500 vs 3000 produces meaningfully different plans.
  const dailyCalorieTarget = clamp(toFiniteNumber(targets?.calories, 2000), 800, 5000);
  // The API adds rice sides later via addRiceSidesToMeals(). Budget for it here so totals stay close.
  const riceSideCaloriesEstimate = 150;
  const breakfastCaloriesTarget = dailyCalorieTarget * 0.25;
  const lunchCaloriesTargetBase = Math.max(150, dailyCalorieTarget * 0.3 - riceSideCaloriesEstimate);
  const dinnerCaloriesTargetBase = Math.max(150, dailyCalorieTarget * 0.3 - riceSideCaloriesEstimate);

  for (const day of DAYS) {
    if (aiDay && aiDay.day === day) {
      const normalizedMeals: any = {};
      Object.entries(aiDay.meals || {}).forEach(([k,v]: any) => {
        normalizedMeals[k] = createMealObject(v);
        if (mealKey(normalizedMeals[k])) used.add(mealKey(normalizedMeals[k]));
      });
      const totals = sumMacros(Object.values(normalizedMeals));
      weekPlan.push({
        day,
        meals: normalizedMeals,
        totalCalories: totals.calories,
        totalProtein: totals.protein,
        totalCarbs: totals.carbs,
        totalFats: totals.fats
      });
      continue;
    }

    // Pick meals by category when possible, otherwise fallback to the full pool.
    const prevDayMeals = weekPlan.length > 0 ? weekPlan[weekPlan.length - 1]?.meals : null;
    const prevDayMainNames = new Set<string>(
      [prevDayMeals?.breakfast, prevDayMeals?.lunch, prevDayMeals?.dinner].map((m: any) => mealKey(m)).filter(Boolean)
    );
    const usedTodayMainNames = new Set<string>();

    const breakfastAvoid = new Set<string>([...prevDayMainNames, ...usedTodayMainNames]);
    const breakfastPick =
      pickUniqueClosestCalories(
        breakfastPool.length > 0 ? breakfastPool : allMainPool,
        used,
        breakfastCaloriesTarget,
        breakfastAvoid
      ) || buildDietFallbackMeal('breakfast', normalizedDietType, breakfastCaloriesTarget, restrictionTokens);
    if (mealKey(breakfastPick)) usedTodayMainNames.add(mealKey(breakfastPick));

    const lunchAvoid = new Set<string>([...prevDayMainNames, ...usedTodayMainNames]);
    const lunchPick =
      pickUniqueClosestCalories(
        lunchPool.length > 0 ? lunchPool : allMainPool,
        used,
        lunchCaloriesTargetBase,
        lunchAvoid
      ) || buildDietFallbackMeal('lunch', normalizedDietType, lunchCaloriesTargetBase, restrictionTokens);
    if (mealKey(lunchPick)) usedTodayMainNames.add(mealKey(lunchPick));

    const dinnerAvoid = new Set<string>([...prevDayMainNames, ...usedTodayMainNames]);
    const dinnerPick =
      pickUniqueClosestCalories(
        dinnerPool.length > 0 ? dinnerPool : allMainPool,
        used,
        dinnerCaloriesTargetBase,
        dinnerAvoid
      ) || buildDietFallbackMeal('dinner', normalizedDietType, dinnerCaloriesTargetBase, restrictionTokens);

    // Pick 2 snacks, aiming to fill remaining calories for the day.
    const mainsCalories = dishCalories(breakfastPick) + dishCalories(lunchPick) + dishCalories(dinnerPick);
    const snacksTotalTarget = Math.max(0, dailyCalorieTarget - mainsCalories);
    const snack1Target = snacksTotalTarget / 2;

    const prevDaySnackNames = new Set<string>(
      [prevDayMeals?.snack1, prevDayMeals?.snack2].map((m: any) => mealKey(m)).filter(Boolean)
    );
    const usedTodaySnackNames = new Set<string>();

    const snack1 =
      pickUniqueClosestCalories(snacksPool, usedSnacks, snack1Target, prevDaySnackNames) ||
      pickUniqueMeals(snacksPool, usedSnacks, 1)[0] ||
      buildDietFallbackMeal('snack1', normalizedDietType, snack1Target, restrictionTokens);
    if (mealKey(snack1)) usedTodaySnackNames.add(mealKey(snack1));

    const snack2Target = Math.max(0, snacksTotalTarget - dishCalories(snack1));
    const snack2Avoid = new Set<string>([...prevDaySnackNames, ...usedTodaySnackNames]);
    const snack2 =
      pickUniqueClosestCalories(snacksPool, usedSnacks, snack2Target, snack2Avoid) ||
      pickUniqueMeals(snacksPool, usedSnacks, 1)[0] ||
      buildDietFallbackMeal('snack2', normalizedDietType, snack2Target, restrictionTokens);

    const mealsObj: any = {
      breakfast: createMealObject(breakfastPick),
      lunch: createMealObject(lunchPick),
      dinner: createMealObject(dinnerPick),
      snack1: createMealObject(snack1),
      snack2: createMealObject(snack2),
    };

    const totals = sumMacros(Object.values(mealsObj));
    weekPlan.push({
      day,
      meals: mealsObj,
      totalCalories: totals.calories,
      totalProtein: totals.protein,
      totalCarbs: totals.carbs,
      totalFats: totals.fats
    });
  }

  return weekPlan;
}

// Safe OpenAI wrapper with timeout
async function safeOpenAICompletionsCreate(params: any, timeoutMs = 12000): Promise<any> {
  if (!openai) {
    throw new Error('OpenAI not configured');
  }
  try {
    const promise = openai.chat.completions.create(params);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('OpenAI timeout')), timeoutMs));
    const completion = await Promise.race([promise, timeout]);
    openaiAvailable = true;
    return completion;
  } catch (err: any) {
    const errMsg = getErrorMessage(err); // changed
    const status = (err?.status || err?.response?.status || err?.code) as any;
    const isAuthErr = status === 401 || /Incorrect API key/i.test(errMsg) || /invalid api key/i.test(errMsg); // changed to use errMsg
    if (isAuthErr) {
      openaiAvailable = false;
      const e = new Error('OPENAI_UNAUTHORIZED');
      (e as any).status = 401;
      throw e;
    }
    throw err;
  }
}

// Utility: ensure a user preference row exists; return its id or null
async function ensureUserPreferenceExists(userId: number): Promise<number | null> {
  try {
    const [rows] = await pool.query<any>('SELECT id FROM user_meal_preferences WHERE user_id = ?', [userId]);
    if (Array.isArray(rows) && rows.length > 0) {
      return Number(rows[0].id);
    }

    const [, insertResult] = await pool.query<any>(
      `INSERT INTO user_meal_preferences (user_id, preferences, created_at)
       VALUES (?, ?, NOW())`,
      [ userId, JSON.stringify({}) ]
    );

    return Number(insertResult.insertId || null);
  } catch (err: any) {
    // Use the helper to extract message safely
    return null;
  }
}

// Add helper to safely extract message from unknown errors
function getErrorMessage(err: unknown): string {
  if (!err) return String(err);
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    if (typeof err === 'object' && err !== null && 'message' in err) {
      return String((err as any).message || JSON.stringify(err));
    }
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Add this helper below getErrorMessage() and above route handlers
function isoDateString(input?: Date | string | null): string {
  if (!input) return new Date().toISOString().split('T')[0];
  const d = input instanceof Date ? input : new Date(String(input));
  if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
  return d.toISOString().split('T')[0];
}

function isFutureDateOnly(input?: string | null): boolean {
  if (!input || typeof input !== 'string') return false;
  const value = input.trim();
  if (!value) return false;

  let dateOnly: Date;
  const ymd = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    dateOnly = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  } else {
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return false;
    dateOnly = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return dateOnly.getTime() > today.getTime();
}

// ============================================
// INPUT VALIDATION HELPERS
// ============================================

// Generate detailed ingredients + recipe instructions using OpenAI
async function generateRecipePackage(mealName: string, ingredients: string[]): Promise<{ ingredients: string[]; recipe: string }> {
  const normalizedIngredients = normalizeDetailedIngredients(ingredients || [], mealName || 'Meal');
  const fallback = { ingredients: normalizedIngredients, recipe: DEFAULT_RECIPE_TEXT };

  if (!openai || !openaiAvailable) {
    return fallback;
  }

  try {
    const completion = await safeOpenAICompletionsCreate({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a Filipino meal-planning and culinary expert. Output STRICT JSON only. Every ingredient must include exact amount + unit and specific type/variant (e.g., pork tocino, chicken tocino, canola oil). Prefer metric units (g, ml) and keep portions practical for one serving. Steps must be numbered, specific, and mention cooking times/heat when relevant."
        },
        {
          role: "user",
          content: `Meal: ${mealName}\nBase ingredients: ${normalizedIngredients.join(', ')}\nReturn JSON only in this shape: {"ingredients":["..."],"recipe":"1. ...\\n2. ..."}`
        }
      ],
      temperature: 0.4,
      max_tokens: 700
    }, 10000);

    const raw = String(completion?.choices?.[0]?.message?.content || '').trim();
    const jsonText = (raw.match(/\{[\s\S]*\}/)?.[0] || raw).trim();
    const parsed = JSON.parse(jsonText || '{}');

    const aiIngredients = normalizeDetailedIngredients(
      Array.isArray(parsed?.ingredients) ? parsed.ingredients.map(String) : normalizedIngredients,
      mealName
    );
    const recipe = String(parsed?.recipe || '').trim();

    return {
      ingredients: aiIngredients,
      recipe: recipe || DEFAULT_RECIPE_TEXT,
    };
  } catch {
    return fallback;
  }
}

async function generateRecipeInstructions(mealName: string, ingredients: string[]): Promise<string> {
  const pkg = await generateRecipePackage(mealName, ingredients);
  return pkg.recipe || DEFAULT_RECIPE_TEXT;
}

// Enrich week plan meals with recipes
async function enrichWeekPlanWithRecipes(weekPlan: any[]): Promise<any[]> {
  if (!Array.isArray(weekPlan)) return weekPlan;
  
  return Promise.all(weekPlan.map(async (day) => {
    if (!day.meals || typeof day.meals !== 'object') return day;
    
    const enrichedMeals: Record<string, any> = {};
    for (const [mealType, meal] of Object.entries(day.meals)) {
      if (!meal || typeof meal !== 'object') {
        enrichedMeals[mealType] = meal;
        continue;
      }
      
      const mealObj = meal as any;
      const existingIngredients = Array.isArray(mealObj.ingredients) ? mealObj.ingredients.map(String) : [];
      const mustUpgradeIngredients = ingredientsNeedUpgrade(existingIngredients);
      const mustUpgradeRecipe = recipeNeedsUpgrade(String(mealObj.recipe || ''));

      if (mustUpgradeIngredients || mustUpgradeRecipe) {
        const pkg = await generateRecipePackage(mealObj.name || "Meal", existingIngredients);
        enrichedMeals[mealType] = {
          ...mealObj,
          ingredients: pkg.ingredients,
          recipe: pkg.recipe || mealObj.recipe || DEFAULT_RECIPE_TEXT,
        };
      } else {
        enrichedMeals[mealType] = {
          ...mealObj,
          ingredients: normalizeDetailedIngredients(existingIngredients, mealObj.name || 'Meal'),
        };
      }
    }
    
    return { ...day, meals: enrichedMeals };
  }));
}

// ===== BASIC ROUTES =====
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
      port: process.env.DB_PORT || '5432'
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: 'Database connection failed'
    });
  }
});

app.get('/api/system/status', async (req: Request, res: Response) => {
  try {
    let dbOk = false;
    let dbDishesCount: number | null = null;
    try {
      await pool.query('SELECT 1');
      dbOk = true;

      // Best-effort: confirm meal DB content exists (avoid failing status endpoint if table missing).
      try {
        const [rows] = await pool.query<any>('SELECT COUNT(*)::int AS count FROM filipino_dishes');
        if (Array.isArray(rows) && rows.length > 0 && typeof rows[0]?.count !== 'undefined') {
          dbDishesCount = Number(rows[0].count);
        }
      } catch {
        dbDishesCount = null;
      }
    } catch (e) {
      dbOk = false;
      dbDishesCount = null;
    }

    const openaiConfigured = !!process.env.OPENAI_API_KEY && typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.trim().length > 0;
    const openaiReady = openaiConfigured && !!openaiAvailable;

    let paypalOk = false;
    try {
      await axios.post(
        `${PAYPAL_API_URL}/oauth2/token`,
        'grant_type=client_credentials',
        {
          timeout: 1500,
          auth: {
            username: PAYPAL_CLIENT_ID,
            password: PAYPAL_CLIENT_SECRET
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      paypalOk = true;
    } catch (e) {
      paypalOk = false;
    }

    return res.json({
      ok: true,
      dbConnected: dbOk,
      dbDishesCount,
      openai: {
        configured: openaiConfigured,
        available: !!openaiAvailable,
        ready: openaiReady,
        model: OPENAI_MODEL,
      },
      paypal: paypalOk,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: getErrorMessage(err) }); // changed
  }
});

// ===== AUTHENTICATION ROUTES =====
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const loginIdRaw = typeof username === 'string' && username.trim() ? username : email;
    const loginId = sanitizeInput(String(loginIdRaw || ''));
    
    // Validate inputs
    if (!loginId || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }
    
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ message: 'Invalid password' });
    }


    const [users] = await pool.query<any>(
      'SELECT * FROM users WHERE LOWER(email) = LOWER(?)',
      [loginId]
    );

    if (!Array.isArray(users) || users.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = users[0];

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role
      }
    });
  } catch (error: any) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ===== DEV UTILITIES (development only) =====
// Creates a JWT for an existing user by username, for local/dev convenience.
app.post('/api/dev/token', async (req, res) => {
  try {
    if (process.env.NODE_ENV !== 'development') {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    const username = String(req.body?.username || req.body?.email || '').trim();
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }

    const [users] = await pool.query<any>(
      'SELECT id, email, first_name, last_name, role FROM users WHERE LOWER(email) = LOWER(?)',
      [username]
    );

    if (!Array.isArray(users) || users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = users[0];
    const token = jwt.sign(
      { id: user.id, role: user.role },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Failed to issue dev token', error: getErrorMessage(err) });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;

    const [users] = await pool.query<any>(
      'SELECT * FROM users WHERE id = ?',
      [userId]
    );

    if (!Array.isArray(users) || users.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(currentPassword, user.password);

    if (!validPassword) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await pool.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, userId]
    );

    res.json({ message: 'Password updated successfully' });
  } catch (error: any) {
    logError('Password change failed', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/register', registerLimiter, async (req: Request, res: Response) => {
  try {
    const {
      firstName,
      lastName,
      email,
      username,
      password,
      phone,
      gender,
      dateOfBirth,
      membershipType,
      membershipPrice,
      emergencyContact,
      address,
      joinDate,
    } = req.body;


    const loginId = sanitizeInput(String(username || email || ''));

    // Validate required fields
    if (!firstName || !lastName || !loginId || !password || !phone) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields' 
      });
    }
    
    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message || 'Password does not meet requirements'
      });
    }
    
    const normalizedPhone = normalizePHMobile(phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Invalid mobile number. Enter exactly 11 digits (09XXXXXXXXX).'
      });
    }
    
    // Sanitize string inputs
    const sanitizedFirstName = sanitizeInput(firstName);
    const sanitizedLastName = sanitizeInput(lastName);
    if (!sanitizedFirstName || !sanitizedLastName) {
      return res.status(400).json({
        success: false,
        message: 'First and last names are required'
      });
    }

    if (typeof dateOfBirth === 'string' && dateOfBirth.trim() && isFutureDateOnly(dateOfBirth)) {
      return res.status(400).json({
        success: false,
        message: 'Date of birth cannot be in the future'
      });
    }

    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER(?)',
      [loginId]
    );

    if ((existingUsers as any[]).length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Username already registered' 
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const subscriptionStart = new Date();
    const subscriptionEnd = new Date();
    
    switch (membershipType || 'monthly') {
      case 'monthly':
        subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 1);
        break;
      case 'quarterly':
        subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 3);
        break;
      case 'annual':
        subscriptionEnd.setFullYear(subscriptionEnd.getFullYear() + 1);
        break;
    }

    
    const [result] = await pool.query(
      `INSERT INTO users (
        first_name, last_name, email, password, phone, 
        gender, date_of_birth, role, status,
        membership_type, membership_price, join_date,
        subscription_start, subscription_end,
        payment_status, emergency_contact, address,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', 'active', ?, ?, ?, ?, ?, 'pending', ?, ?, NOW())`,
      [
        firstName,
        lastName,
        loginId,
        hashedPassword,
        normalizedPhone,
        gender || 'male',
        dateOfBirth || null,
        membershipType || 'monthly',
        membershipPrice || 100,
        isoDateString(req.body?.joinDate || joinDate), // safe access — prefer req.body.joinDate if present
        isoDateString(subscriptionStart), // was subscriptionStart.toISOString().split('T')[0]
        isoDateString(subscriptionEnd), // was subscriptionEnd.toISOString().split('T')[0]
        emergencyContact || null,
        address || null,
      ]
    );

    const userId = (result as any).insertId;


    res.status(201).json({
      success: true,
      message: 'Member registered successfully',
      userId,
    });
  } catch (error: any) {
    logError('User registration failed', error, { username: req.body.username || req.body.email });
    res.status(500).json({ 
      success: false, 
      message: getErrorMessage(error) || 'Registration failed' 
    });
  }
});

// ===== MEMBER MANAGEMENT ROUTES =====
app.get('/api/members', authenticateToken, requireAdmin, async (req, res) => {
  try {
    
    // PostgreSQL-safe: avoid GROUP BY across many selected columns.
    // Use a correlated subquery for payment count instead.
    const [members] = await pool.query<any>(
      `SELECT
        u.id,
        u.email,
        u.first_name as "firstName",
        u.last_name as "lastName",
        u.phone,
        u.gender,
        u.date_of_birth as "dateOfBirth",
        u.membership_type as "membershipType",
        u.membership_price as "membershipPrice",
        u.join_date as "joinDate",
        u.status,
        u.payment_status as "paymentStatus",
        u.subscription_start as "subscriptionStart",
        u.subscription_end as "subscriptionEnd",
        u.emergency_contact as "emergencyContact",
        u.address,
        (
          SELECT p.payment_status
          FROM payments p
          WHERE p.user_id = u.id
            AND COALESCE(p.payment_status, '') IN ('paid', 'completed')
          ORDER BY COALESCE(p.payment_date, p.created_at) DESC
          LIMIT 1
        ) as "latestPaidStatus",
        (
          SELECT p.membership_type
          FROM payments p
          WHERE p.user_id = u.id
            AND COALESCE(p.payment_status, '') IN ('paid', 'completed')
          ORDER BY COALESCE(p.payment_date, p.created_at) DESC
          LIMIT 1
        ) as "latestPaidMembershipType",
        (
          SELECT p.amount
          FROM payments p
          WHERE p.user_id = u.id
            AND COALESCE(p.payment_status, '') IN ('paid', 'completed')
          ORDER BY COALESCE(p.payment_date, p.created_at) DESC
          LIMIT 1
        ) as "latestPaidAmount",
        (
          SELECT p.subscription_start
          FROM payments p
          WHERE p.user_id = u.id
            AND COALESCE(p.payment_status, '') IN ('paid', 'completed')
          ORDER BY COALESCE(p.payment_date, p.created_at) DESC
          LIMIT 1
        ) as "latestPaidSubscriptionStart",
        (
          SELECT p.subscription_end
          FROM payments p
          WHERE p.user_id = u.id
            AND COALESCE(p.payment_status, '') IN ('paid', 'completed')
          ORDER BY COALESCE(p.payment_date, p.created_at) DESC
          LIMIT 1
        ) as "latestPaidSubscriptionEnd",
        (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id) as "totalPayments"
      FROM users u
      WHERE u.role = 'member'`
    );

    
    const normalizeMemberStatus = (raw: any): 'active' | 'inactive' => {
      const s = String(raw ?? '').toLowerCase().trim();
      return s === 'active' ? 'active' : 'inactive';
    };

    const transformedMembers = members.map((member: any) => {
      const latestPaidStatus = String(member.latestPaidStatus || '').toLowerCase();
      const userPaymentStatus = String(member.paymentStatus || '').toLowerCase();
      const hasPaidEvidence = latestPaidStatus === 'paid' || latestPaidStatus === 'completed';
      const normalizedPaymentStatus = hasPaidEvidence
        ? 'paid'
        : userPaymentStatus === 'completed'
          ? 'paid'
          : ['paid', 'pending', 'expired', 'cancelled'].includes(userPaymentStatus)
            ? userPaymentStatus
            : 'pending';

      const membershipType = member.latestPaidMembershipType || member.membershipType || 'monthly';
      const membershipPrice = Number(member.latestPaidAmount) || parseFloat(member.membershipPrice) || 100;
      const subscriptionStart = member.latestPaidSubscriptionStart || member.subscriptionStart;
      const subscriptionEnd = member.latestPaidSubscriptionEnd || member.subscriptionEnd;

      return {
        id: member.id,
        firstName: member.firstName || '',
        lastName: member.lastName || '',
        email: member.email,
        phone: member.phone || '',
        gender: member.gender || 'male',
        dateOfBirth: member.dateOfBirth ? new Date(member.dateOfBirth).toISOString().split('T')[0] : '',
        membershipType,
        membershipPrice,
        joinDate: member.joinDate ? new Date(member.joinDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        status: hasPaidEvidence ? 'active' : normalizeMemberStatus(member.status),
        paymentStatus: normalizedPaymentStatus,
        subscriptionStart: subscriptionStart ? new Date(subscriptionStart).toISOString().split('T')[0] : null,
        subscriptionEnd: subscriptionEnd ? new Date(subscriptionEnd).toISOString().split('T')[0] : null,
        emergencyContact: member.emergencyContact || '',
        address: member.address || '',
        totalPayments: member.totalPayments || 0,
      };
    });

    res.json(transformedMembers);
  } catch (error: any) {
    res.status(500).json({ message: 'Server error', error: getErrorMessage(error) });
  }
});

app.post('/api/members', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { 
      firstName, 
      lastName, 
      email, 
      username,
      password, 
      phone, 
      gender, 
      dateOfBirth, 
      membershipType, 
      membershipPrice,
      joinDate,
      status,
      emergencyContact,
      address,
      
    } = req.body;

    const loginId = sanitizeInput(String(username || email || ''));

    if (!firstName || !lastName || !loginId || !password || !phone) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    if (typeof dateOfBirth === 'string' && dateOfBirth.trim() && isFutureDateOnly(dateOfBirth)) {
      return res.status(400).json({ message: 'Date of birth cannot be in the future' });
    }

    const normalizedPhone = normalizePHMobile(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ message: 'Invalid mobile number. Enter exactly 11 digits (09XXXXXXXXX).' });
    }

    const [existing] = await pool.query<any>(
      'SELECT id FROM users WHERE LOWER(email) = LOWER(?)',
      [loginId]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const subscriptionStart = new Date();
    const subscriptionEnd = new Date();
    
    switch(membershipType) {
      case 'monthly':
        subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 1);
        break;
      case 'quarterly':
        subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 3);
        break;
      case 'annual':
        subscriptionEnd.setFullYear(subscriptionEnd.getFullYear() + 1);
        break;
    }
    
    const [rows] = await pool.query<any>(
      `INSERT INTO users (
        first_name, last_name, email, password, phone, 
        gender, date_of_birth, role, status,
        membership_type, membership_price, join_date,
        subscription_start, subscription_end,
        payment_status, emergency_contact, address,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NOW())
      RETURNING id`,
      [
        firstName,
        lastName,
        loginId,
        hashedPassword,
        normalizedPhone,
        gender || 'male',
        dateOfBirth || null,
        status || 'active',
        membershipType || 'monthly',
        membershipPrice || 100,
        joinDate || isoDateString(new Date()), // in the insert values: use isoDateString for joinDate default
        isoDateString(subscriptionStart), // was subscriptionStart.toISOString().split('T')[0]
        isoDateString(subscriptionEnd),   // was subscriptionEnd.toISOString().split('T')[0]
        emergencyContact || null,
        address || null
      ]
    );

    const insertId = rows?.[0]?.id;


    res.status(201).json({ 
      success: true,
      message: 'Member added successfully',
      id: insertId
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Server error', error: getErrorMessage(error) });
  }
});

app.put('/api/members/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const memberId = req.params.id;
    const {
      firstName,
      lastName,
      email,
      password,
      phone,
      gender,
      dateOfBirth,
      membershipType,
      membershipPrice,
      status,
      emergencyContact,
      address,
      joinDate,
    } = req.body;

    const hasText = (v: any) => typeof v === 'string' && v.trim() !== '';


    let updateFields = [];
    let updateValues = [];

    if (hasText(firstName)) {
      updateFields.push('first_name = ?');
      updateValues.push(firstName.trim());
    }
    if (hasText(lastName)) {
      updateFields.push('last_name = ?');
      updateValues.push(lastName.trim());
    }
    if (hasText(email)) {
      updateFields.push('email = ?');
      updateValues.push(email.trim());
    }
    if (hasText(password)) {
      const hashedPassword = await bcrypt.hash(password, 12);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }
    if (hasText(phone)) {
      const normalizedPhone = normalizePHMobile(phone);
      if (!normalizedPhone) {
        return res.status(400).json({ message: 'Invalid mobile number. Enter exactly 11 digits (09XXXXXXXXX).' });
      }
      updateFields.push('phone = ?');
      updateValues.push(normalizedPhone);
    }
    if (hasText(gender)) {
      updateFields.push('gender = ?');
      updateValues.push(gender.trim());
    }
    if (hasText(dateOfBirth)) {
      if (isFutureDateOnly(dateOfBirth.trim())) {
        return res.status(400).json({ message: 'Date of birth cannot be in the future' });
      }
      updateFields.push('date_of_birth = ?');
      updateValues.push(dateOfBirth.trim());
    }
    if (hasText(membershipType)) {
      updateFields.push('membership_type = ?');
      updateValues.push(membershipType.trim());
    }
    if (membershipPrice !== undefined && membershipPrice !== null && membershipPrice !== '') {
      updateFields.push('membership_price = ?');
      updateValues.push(membershipPrice);
    }
    if (hasText(status)) {
      updateFields.push('status = ?');
      updateValues.push(status.trim());
    }
    // Blank strings mean "no change" (admin can update only the fields they type)
    if (hasText(emergencyContact)) {
      updateFields.push('emergency_contact = ?');
      updateValues.push(emergencyContact.trim());
    }
    if (hasText(address)) {
      updateFields.push('address = ?');
      updateValues.push(address.trim());
    }
    if (hasText(joinDate)) {
      updateFields.push('join_date = ?');
      updateValues.push(joinDate.trim());
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    updateValues.push(memberId);

    await pool.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );


    res.json({ 
      success: true,
      message: 'Member updated successfully' 
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Server error', error: getErrorMessage(error) });
  }
});

app.delete('/api/members/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      'DELETE FROM users WHERE id = ? AND role = \'member\'',
      [id]
    );

    if ((result as any).affectedRows === 0) {
      return res.status(404).json({ message: 'Member not found' });
    }

    res.json({ message: 'Member deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ message: 'Server error', error: getErrorMessage(error) });
  }
});

// ===== PAYMENT ROUTES =====
app.get('/api/member/subscription', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const normalizePlan = (raw: any): 'monthly' | 'quarterly' | 'annual' => {
      const v = String(raw || '').trim().toLowerCase();
      if (v === 'quarterly') return 'quarterly';
      if (v === 'annual') return 'annual';
      return 'monthly';
    };

    const parseDateSafe = (value: any): Date | null => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const computeEndDate = (start: Date, plan: 'monthly' | 'quarterly' | 'annual'): Date => {
      const end = new Date(start);
      if (plan === 'quarterly') end.setMonth(end.getMonth() + 3);
      else if (plan === 'annual') end.setFullYear(end.getFullYear() + 1);
      else end.setMonth(end.getMonth() + 1);
      return end;
    };

    const defaultPriceByPlan = (plan: 'monthly' | 'quarterly' | 'annual') => {
      return expectedAmountForPlan(plan);
    };

    const [member] = await pool.query<any>(
      `SELECT 
        id, email, first_name as firstName, last_name as lastName,
        membership_type as membershipType, membership_price as membershipPrice,
        subscription_start as subscriptionStart, subscription_end as subscriptionEnd,
        payment_status as paymentStatus, status
      FROM users WHERE id = ? AND role = 'member'`,
      [userId]
    );

    if (member.length === 0) {
      return res.status(404).json({ message: 'Member not found' });
    }

    const row = member[0] as any;
    const userEnd = parseDateSafe(row.subscriptionEnd);
    const userPlan = String(row.membershipType || '').trim().toLowerCase();
    const userPaid = String(row.paymentStatus || '').toLowerCase() === 'paid';

    // Self-heal legacy/inconsistent user subscription fields from latest paid payment record.
    const needsRepair = !userEnd || !userPlan || !userPaid;
    if (needsRepair) {
      const [latestRows] = await pool.query<any>(
        `SELECT 
           membership_type as membershipType,
           amount,
           subscription_start as subscriptionStart,
           subscription_end as subscriptionEnd,
           payment_status as paymentStatus,
           payment_date as paymentDate,
           created_at as createdAt
         FROM payments
         WHERE user_id = ? AND COALESCE(payment_status, '') IN ('paid', 'completed')
         ORDER BY COALESCE(payment_date, created_at) DESC
         LIMIT 1`,
        [userId]
      );

      if (Array.isArray(latestRows) && latestRows.length > 0) {
        const latest = latestRows[0] as any;
        const plan = normalizePlan(latest.membershipType || row.membershipType);
        const start = parseDateSafe(latest.subscriptionStart)
          || parseDateSafe(latest.paymentDate)
          || parseDateSafe(latest.createdAt)
          || new Date();
        const end = parseDateSafe(latest.subscriptionEnd) || computeEndDate(start, plan);
        const price = Number(latest.amount) || Number(row.membershipPrice) || defaultPriceByPlan(plan);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const isActive = end.getTime() >= today.getTime();
        const paymentStatus = isActive ? 'paid' : 'expired';
        const status = isActive ? 'active' : (row.status || 'inactive');

        await pool.query(
          `UPDATE users
             SET membership_type = ?,
                 membership_price = ?,
                 subscription_start = ?,
                 subscription_end = ?,
                 payment_status = ?,
                 status = ?
           WHERE id = ?`,
          [
            plan,
            price,
            isoDateString(start),
            isoDateString(end),
            paymentStatus,
            status,
            userId,
          ]
        );

        return res.json({
          ...row,
          membershipType: plan,
          membershipPrice: price,
          subscriptionStart: isoDateString(start),
          subscriptionEnd: isoDateString(end),
          paymentStatus,
          status,
        });
      }
    }

    res.json(row);
  } catch (error: any) {
    res.status(500).json({ message: 'Server error', error: getErrorMessage(error) });
  }
});

app.post(['/api/member/payment/paypal', '/api/member/payment/gcash'], authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { userId: bodyUserId, membershipType, amount, paymentMethod } = req.body;
    // Use userId from token if not provided in body (for renewal cases)
    const userId = bodyUserId || req.user?.id;


    if (!userId || !membershipType || !amount) {
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields: userId=' + (userId ? 'OK' : 'MISSING') + ', membershipType=' + (membershipType ? 'OK' : 'MISSING') + ', amount=' + (amount ? 'OK' : 'MISSING')
      });
    }

    const transactionId = `PAYPAL-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const normalizedPaymentMethod =
      String(paymentMethod || 'paypal').toLowerCase() === 'gcash'
        ? 'paypal'
        : String(paymentMethod || 'paypal').toLowerCase();

    const normalizedMembershipType = normalizeMembershipPlan(membershipType);
    const { subscriptionStart, subscriptionEnd } = await resolveSubscriptionWindow(
      Number(userId),
      normalizedMembershipType
    );

    const paymentStatus = 'paid';

    const [result] = await pool.query(
      `INSERT INTO payments (
        user_id, amount, payment_date, payment_method,
        membership_type, payment_status, transaction_id,
        subscription_start, subscription_end
      ) VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
      [
        userId, 
        amount, 
        normalizedPaymentMethod,
        normalizedMembershipType,
        paymentStatus, 
        transactionId,
        isoDateString(subscriptionStart), // was subscriptionStart.toISOString().split('T')[0]
        isoDateString(subscriptionEnd),   // was subscriptionEnd.toISOString().split('T')[0]
      ]
    );

    await pool.query(
      `UPDATE users 
       SET status = 'active',
           payment_status = 'paid',
           subscription_start = ?,
           subscription_end = ?,
           grace_until = NULL,
           membership_type = ?,
           membership_price = ?
       WHERE id = ?`,
      [
        isoDateString(subscriptionStart), // was subscriptionStart.toISOString().split('T')[0]
        isoDateString(subscriptionEnd),   // was subscriptionEnd.toISOString().split('T')[0]
        normalizedMembershipType,
        amount,
        userId
      ]
    );


    res.status(201).json({
      success: true,
      message: '✅ Payment successful! Your subscription is now active.',
      paymentId: (result as any).insertId,
      transactionId,
      paymentStatus: 'paid',
      subscription: {
        start: subscriptionStart.toISOString().split('T')[0],
        end: subscriptionEnd.toISOString().split('T')[0],
        type: normalizedMembershipType,
        amount: amount
      }
    });

  } catch (error: any) {
    res.status(500).json({ success: false, message: getErrorMessage(error) || 'Payment processing failed' });
  }
});

app.post('/api/admin/payments/record-cash', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { userId, membershipType, amount, paymentMethod, notes } = req.body;

    if (!userId || !amount || !membershipType) {
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields' 
      });
    }

    const parsedUserId = Number(userId);
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedUserId) || parsedUserId <= 0 || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment payload',
      });
    }

    const normalizedMembershipType = normalizeMembershipPlan(membershipType);
    const normalizedPaymentMethod = String(paymentMethod || 'cash').toLowerCase();

    const transactionId = `CASH-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const paymentStatus = 'pending';

    const hasPaymentNotes = await dbColumnExists('payments', 'notes');
    const [result] = hasPaymentNotes
      ? await pool.query(
          `INSERT INTO payments (
            user_id, amount, payment_method,
            membership_type, payment_status, transaction_id, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            parsedUserId,
            parsedAmount,
            normalizedPaymentMethod,
            normalizedMembershipType,
            paymentStatus,
            transactionId,
            notes || '',
          ]
        )
      : await pool.query(
          `INSERT INTO payments (
            user_id, amount, payment_method,
            membership_type, payment_status, transaction_id
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            parsedUserId,
            parsedAmount,
            normalizedPaymentMethod,
            normalizedMembershipType,
            paymentStatus,
            transactionId,
          ]
        );

    res.status(201).json({
      success: true,
      message: 'Payment recorded and queued for admin approval.',
      paymentId: (result as any).insertId,
      transactionId,
      paymentStatus: 'pending',
    });

  } catch (error: any) {
    res.status(500).json({ success: false, message: getErrorMessage(error) || 'Failed to record payment' });
  }
});

// GET ALL PAYMENTS FOR ADMIN DASHBOARD (ADMIN)
app.get('/api/admin/payments/all', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const [payments] = await pool.query<any>(`
      SELECT 
        p.id,
        p.user_id,
        p.amount,
        p.payment_method,
        p.membership_type,
        COALESCE(p.payment_status, 'paid') as payment_status,
        p.payment_date,
        p.transaction_id,
        p.subscription_start,
        p.subscription_end,
        u.first_name as "firstName",
        u.last_name as "lastName",
        u.email
      FROM payments p
      INNER JOIN users u ON p.user_id = u.id
      ORDER BY p.payment_date DESC
    `);

    res.json(payments);
  } catch (error: any) {
    res.status(500).json({ success: false, message: 'Failed to get payments', error: getErrorMessage(error) });
  }
});

// GET PENDING PAYMENTS FOR ADMIN REVIEW
app.get('/api/admin/payments/pending', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const hasPaymentNotes = await dbColumnExists('payments', 'notes');
    const notesExpr = hasPaymentNotes ? `COALESCE(p.notes, '')` : `''`;

    const [payments] = await pool.query<any>(`
      SELECT
        p.id,
        p.user_id,
        p.amount,
        p.payment_method,
        p.membership_type,
        COALESCE(p.payment_status, 'pending') as payment_status,
        p.payment_date,
        p.transaction_id,
        ${notesExpr} as notes,
        u.first_name as "firstName",
        u.last_name as "lastName",
        u.email
      FROM payments p
      INNER JOIN users u ON p.user_id = u.id
      WHERE COALESCE(p.payment_status, 'pending') = 'pending'
      ORDER BY COALESCE(p.payment_date, p.created_at) DESC
    `);

    return res.json(payments);
  } catch (error: any) {
    return res.status(500).json({ success: false, message: getErrorMessage(error) || 'Failed to load pending payments' });
  }
});

// APPROVE A PENDING PAYMENT (ADMIN)
app.post('/api/admin/payments/:id/approve', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const paymentId = Number(req.params.id);
    if (!Number.isFinite(paymentId)) {
      return res.status(400).json({ success: false, message: 'Invalid payment id' });
    }

    const [rows] = await pool.query<any>(
      `SELECT id, user_id, amount, membership_type, payment_status
       FROM payments
       WHERE id = ?
       LIMIT 1`,
      [paymentId]
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    const payment = rows[0] as any;
    const currentStatus = String(payment.payment_status || '').toLowerCase();
    if (currentStatus === 'paid' || currentStatus === 'completed') {
      return res.status(400).json({ success: false, message: 'Payment already approved' });
    }

    const membershipType = normalizeMembershipPlan(payment.membership_type || 'monthly');
    const amount = Number(payment.amount) || 0;

    const { subscriptionStart, subscriptionEnd } = await resolveSubscriptionWindow(
      Number(payment.user_id),
      membershipType
    );

    await pool.query(
      `UPDATE payments
       SET payment_status = 'paid', payment_date = NOW(),
           subscription_start = ?, subscription_end = ?
       WHERE id = ?`,
      [
        isoDateString(subscriptionStart),
        isoDateString(subscriptionEnd),
        paymentId,
      ]
    );

    await pool.query(
      `UPDATE users
       SET status = 'active',
           payment_status = 'paid',
           subscription_start = ?,
           subscription_end = ?,
           grace_until = NULL,
           membership_type = ?,
           membership_price = ?
       WHERE id = ?`,
      [
        isoDateString(subscriptionStart),
        isoDateString(subscriptionEnd),
        membershipType,
        amount,
        payment.user_id,
      ]
    );

    return res.json({
      success: true,
      message: 'Payment approved successfully',
      subscription: {
        start: isoDateString(subscriptionStart),
        end: isoDateString(subscriptionEnd),
        type: membershipType,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: getErrorMessage(error) || 'Failed to approve payment' });
  }
});

// REJECT A PENDING PAYMENT (ADMIN)
app.post('/api/admin/payments/:id/reject', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const paymentId = Number(req.params.id);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isFinite(paymentId)) {
      return res.status(400).json({ success: false, message: 'Invalid payment id' });
    }

    const hasPaymentNotes = await dbColumnExists('payments', 'notes');

    const [result] = hasPaymentNotes
      ? await pool.query<any>(
          `UPDATE payments
           SET payment_status = 'rejected',
               notes = CASE
                 WHEN COALESCE(notes, '') = '' THEN ?
                 ELSE CONCAT(notes, ' | Rejected: ', ?)
               END
           WHERE id = ?`,
          [reason || 'Rejected by admin', reason || 'Rejected by admin', paymentId]
        )
      : await pool.query<any>(
          `UPDATE payments
           SET payment_status = 'rejected'
           WHERE id = ?`,
          [paymentId]
        );

    if (!(result as any)?.affectedRows) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    return res.json({ success: true, message: 'Payment rejected successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: getErrorMessage(error) || 'Failed to reject payment' });
  }
});

// DELETE PAYMENT RECORD (ADMIN)
app.delete('/api/admin/payments/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const paymentId = Number(req.params.id);
    if (!Number.isFinite(paymentId)) {
      return res.status(400).json({ success: false, message: 'Invalid payment id' });
    }

    const [result] = await pool.query<any>(
      `DELETE FROM payments WHERE id = ?`,
      [paymentId]
    );

    if (!(result as any)?.affectedRows) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    return res.json({ success: true, message: 'Payment deleted successfully' });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: getErrorMessage(error) || 'Failed to delete payment' });
  }
});

// ADMIN PAYMENT SUMMARY ROUTE
app.get('/api/admin/payments/summary', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    // Use explicit text casts for PostgreSQL enum compatibility.
    const statusExpr = `LOWER(TRIM(COALESCE(payment_status::text, ''))) `;
    const methodExpr = `LOWER(TRIM(COALESCE(payment_method::text, ''))) `;
    const paidWhere = `(payment_status IS NULL OR ${statusExpr} IN ('paid', 'completed', 'approved', 'success'))`;
    const pendingWhere = `${statusExpr} IN ('pending', 'pending_approval')`;
    // Cash records from Members Management use CASH-* transaction IDs.
    // Include pending cash in total revenue while still requiring approval for account activation.
    const manualPendingCashWhere = `((${statusExpr} IN ('pending', 'pending_approval')) AND (transaction_id LIKE 'CASH-%' OR ${methodExpr} = 'cash'))`;
    const revenueWhere = `(${paidWhere} OR ${manualPendingCashWhere})`;

    // Total revenue (paid + manually recorded pending cash)
    const [revenueRows] = await pool.query<any>(`
      SELECT SUM(amount) as "totalRevenue"
      FROM payments
      WHERE ${revenueWhere}
    `);

    // Count of pending payments
    const [pendingRows] = await pool.query<any>(`
      SELECT COUNT(*) as "pendingPayments"
      FROM payments
      WHERE ${pendingWhere}
    `);

    // Count of paid payments
    const [paidRows] = await pool.query<any>(`
      SELECT COUNT(*) as "paidPayments"
      FROM payments
      WHERE ${paidWhere}
    `);

    const revenueValue = Number(
      revenueRows?.[0]?.totalRevenue
      ?? revenueRows?.[0]?.totalrevenue
      ?? 0
    ) || 0;
    const pendingValue = Number(
      pendingRows?.[0]?.pendingPayments
      ?? pendingRows?.[0]?.pendingpayments
      ?? 0
    ) || 0;
    const paidValue = Number(
      paidRows?.[0]?.paidPayments
      ?? paidRows?.[0]?.paidpayments
      ?? 0
    ) || 0;

    res.json({
      success: true,
      totalRevenue: revenueValue,
      pendingPayments: pendingValue,
      paidPayments: paidValue,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to get payment summary' });
  }
});

// ===== MEAL PLANNER ROUTES =====
function parseJsonValue(value: any): any {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  const str = String(value || '').trim();
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

async function getUserMealPreferences(userId: number): Promise<any | null> {
  try {
    const [rows] = await pool.query<any>(
      'SELECT * FROM user_meal_preferences WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      [userId]
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const row = rows[0] as any;
    const prefJson = row.preferences ? (parseJsonValue(row.preferences) || {}) : null;

    let allergies: any[] = [];
    if (prefJson && typeof prefJson === 'object' && Array.isArray((prefJson as any).allergies)) {
      allergies = (prefJson as any).allergies;
    } else if (row.allergies) {
      const parsed = parseJsonValue(row.allergies);
      if (Array.isArray(parsed)) allergies = parsed;
    } else if (row.dietary_restrictions) {
      const dr = parseJsonValue(row.dietary_restrictions) ?? row.dietary_restrictions;
      if (Array.isArray(dr)) {
        allergies = dr;
      } else if (dr && typeof dr === 'object') {
        const maybe = (dr as any).allergies || (dr as any).avoid || (dr as any).tokens;
        if (Array.isArray(maybe)) allergies = maybe;
      }
    }

    const targets = parseJsonValue(row.targets) ?? row.targets ?? (prefJson ? (prefJson as any).targets : null);

    return {
      lifestyle: prefJson?.lifestyle ?? row.lifestyle ?? null,
      mealType: prefJson?.mealType ?? row.meal_type ?? row.mealType ?? null,
      goal: prefJson?.goal ?? row.goal ?? null,
      diet: prefJson?.diet ?? row.diet ?? null,
      allergies,
      healthConditions: Array.isArray(prefJson?.healthConditions) ? prefJson.healthConditions : [],
      demographics: prefJson?.demographics ?? null,
      dietaryRestrictions: prefJson?.dietaryRestrictions ?? null,
      socioeconomic: prefJson?.socioeconomic ?? null,
      lifestyleFactors: prefJson?.lifestyleFactors ?? null,
      targets: targets && typeof targets === 'object' ? targets : null,
    };
  } catch {
    return null;
  }
}

async function upsertUserMealPreferences(userId: number, prefs: any): Promise<void> {
  const payload = prefs && typeof prefs === 'object' ? prefs : {};

  // Schema detection (supports both legacy JSON `preferences` and column-based schemas).
  const hasPrefsJson = await dbColumnExists('user_meal_preferences', 'preferences');
  if (hasPrefsJson) {
    const [rows] = await pool.query<any>('SELECT id FROM user_meal_preferences WHERE user_id = ? LIMIT 1', [userId]);
    const json = JSON.stringify(payload);
    if (Array.isArray(rows) && rows.length > 0) {
      await pool.query('UPDATE user_meal_preferences SET preferences = ? WHERE user_id = ?', [json, userId]);
    } else {
      await pool.query(
        'INSERT INTO user_meal_preferences (user_id, preferences, created_at) VALUES (?, ?, NOW())',
        [userId, json]
      );
    }
    return;
  }

  const hasLifestyle = await dbColumnExists('user_meal_preferences', 'lifestyle');
  const hasMealType = await dbColumnExists('user_meal_preferences', 'meal_type');
  const hasGoal = await dbColumnExists('user_meal_preferences', 'goal');
  const hasDiet = await dbColumnExists('user_meal_preferences', 'diet');
  const hasDietaryRestrictions = await dbColumnExists('user_meal_preferences', 'dietary_restrictions');
  const hasTargets = await dbColumnExists('user_meal_preferences', 'targets');

  const setClauses: string[] = [];
  const values: any[] = [];

  if (hasLifestyle) { setClauses.push('lifestyle = ?'); values.push(payload.lifestyle ?? null); }
  if (hasMealType) { setClauses.push('meal_type = ?'); values.push(payload.mealType ?? payload.meal_type ?? null); }
  if (hasGoal) { setClauses.push('goal = ?'); values.push(payload.goal ?? null); }
  if (hasDiet) { setClauses.push('diet = ?'); values.push(payload.diet ?? null); }
  if (hasDietaryRestrictions) {
    const dr = {
      allergies: Array.isArray(payload.allergies) ? payload.allergies : [],
      deprecatedDietaryRestrictions: Array.isArray(payload.dietaryRestrictions) ? payload.dietaryRestrictions : [],
    };
    setClauses.push('dietary_restrictions = ?');
    values.push(JSON.stringify(dr));
  }
  if (hasTargets) {
    setClauses.push('targets = ?');
    values.push(payload.targets ? JSON.stringify(payload.targets) : null);
  }

  if (setClauses.length === 0) return;

  const [rows] = await pool.query<any>('SELECT id FROM user_meal_preferences WHERE user_id = ? LIMIT 1', [userId]);
  if (Array.isArray(rows) && rows.length > 0) {
    await pool.query(`UPDATE user_meal_preferences SET ${setClauses.join(', ')} WHERE user_id = ?`, [...values, userId]);
  } else {
    const insertCols: string[] = ['user_id'];
    const insertVals: any[] = [userId];
    const insertPlaceholders: string[] = ['?'];

    // Mirror the set clauses into an INSERT.
    if (hasLifestyle) { insertCols.push('lifestyle'); insertVals.push(payload.lifestyle ?? null); insertPlaceholders.push('?'); }
    if (hasMealType) { insertCols.push('meal_type'); insertVals.push(payload.mealType ?? payload.meal_type ?? null); insertPlaceholders.push('?'); }
    if (hasGoal) { insertCols.push('goal'); insertVals.push(payload.goal ?? null); insertPlaceholders.push('?'); }
    if (hasDiet) { insertCols.push('diet'); insertVals.push(payload.diet ?? null); insertPlaceholders.push('?'); }
    if (hasDietaryRestrictions) {
      const dr = {
        allergies: Array.isArray(payload.allergies) ? payload.allergies : [],
        deprecatedDietaryRestrictions: Array.isArray(payload.dietaryRestrictions) ? payload.dietaryRestrictions : [],
      };
      insertCols.push('dietary_restrictions'); insertVals.push(JSON.stringify(dr)); insertPlaceholders.push('?');
    }
    if (hasTargets) { insertCols.push('targets'); insertVals.push(payload.targets ? JSON.stringify(payload.targets) : null); insertPlaceholders.push('?'); }

    await pool.query(
      `INSERT INTO user_meal_preferences (${insertCols.join(', ')}) VALUES (${insertPlaceholders.join(', ')})`,
      insertVals
    );
  }
}

// Load saved preferences for the current user.
app.get('/api/meal-planner/preferences', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const preferences = await getUserMealPreferences(userId);
    return res.json({ success: true, hasPreferences: !!preferences, preferences: preferences || {} });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Failed to load preferences', error: getErrorMessage(err) });
  }
});

// Save/update preferences for the current user.
app.post('/api/meal-planner/preferences', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await upsertUserMealPreferences(userId, req.body || {});
    const preferences = await getUserMealPreferences(userId);
    return res.json({ success: true, hasPreferences: !!preferences, preferences: preferences || {} });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Failed to save preferences', error: getErrorMessage(err) });
  }
});

// GENERATE MEAL PLAN (AI-POWERED)
app.post('/api/meal-planner/generate', authenticateToken, async (req: AuthRequest, res: Response) => {

  try {
    const userId = req.user!.id;
    const { lifestyle, mealType, goal, diet, allergies, dietaryRestrictions, targets, planName } = req.body;
    const healthConditions = normalizeHealthConditions(req.body?.healthConditions || req.body?.healthCondition);
    const normalizedDietaryRestrictions = normalizeDietaryRestrictions(dietaryRestrictions);
    const inferredDiet = inferDietFromRestrictions(normalizedDietaryRestrictions);

    // Dietary restrictions dropdown was removed in the client; keep backwards compatibility
    // by treating any provided dietaryRestrictions as additional "avoid" tokens.
    const allergyTokens = normalizeSelectionList(allergies);
    const deprecatedRestrictionTokens = normalizeSelectionList(dietaryRestrictions);
    const profileRestrictionTokens = getRestrictionTokensFromProfile(normalizedDietaryRestrictions, healthConditions);
    const allRestrictionTokens = Array.from(new Set([...allergyTokens, ...deprecatedRestrictionTokens, ...profileRestrictionTokens]));
    const normalizedDiet = normalizeDietType(diet || inferredDiet);
    const nutritionProfile = normalizeMealPlannerProfile(
      { ...(req.body || {}), healthConditions, dietaryRestrictions: normalizedDietaryRestrictions },
      normalizedDiet,
      allRestrictionTokens
    );
    const citationIds = getCitationIdsForProfile(nutritionProfile, allergyTokens.length > 0);
    const citations = selectCitations(citationIds);
    const evidenceSummary = buildEvidenceSummary(nutritionProfile, targets, citationIds);

    // Best-effort persist preferences for later reload in the UI.
    try {
      await upsertUserMealPreferences(userId, {
        lifestyle,
        mealType,
        goal,
        diet: normalizedDiet,
        allergies: allergyTokens,
        healthConditions,
        demographics: nutritionProfile.demographics,
        dietaryRestrictions: normalizedDietaryRestrictions,
        socioeconomic: nutritionProfile.socioeconomic,
        lifestyleFactors: nutritionProfile.lifestyleFactors,
        // keep deprecated field for older schemas/clients
        deprecatedDietaryRestrictions: deprecatedRestrictionTokens,
        targets,
      });
    } catch {
      // ignore preference persistence errors
    }

    if (!dbConnected) {
      let weekPlan = generateWeekPlan(null, targets, goal, allRestrictionTokens, undefined, normalizedDiet);
      weekPlan = addRiceSidesToMeals(weekPlan);
      weekPlan = scaleWeekPlanToCalorieTarget(weekPlan, targets);
      weekPlan = recomputeWeekPlanTotals(weekPlan);
      weekPlan = annotateWeekPlanWithEvidence(weekPlan, nutritionProfile, citationIds);
      return res.status(503).json({
        success: false,
        message: 'Database not connected — returning fallback plan',
        mealPlan: {
          weekPlan,
          shoppingList: generateShoppingList(weekPlan),
          mealPrepTips: getMealPrepTips(weekPlan),
          nutritionTips: getNutritionTips(goal),
          evidenceSummary,
          citations,
          profileSummary: nutritionProfile
        },
        saved: false
      });
    }

    const [dbDishes] = await pool.query<any>('SELECT * FROM filipino_dishes ORDER BY name ASC');

    // Apply best-effort filtering so restricted dishes are not offered to the AI.
    const tokenFilteredDbDishes = filterDishesByTokens(dbDishes || [], allRestrictionTokens);
    const dietFilteredDbDishes = filterDishesByDiet(tokenFilteredDbDishes, normalizedDiet);
    const profileFilteredDbDishes = filterDishesByHealthProfile(
      normalizedDiet ? dietFilteredDbDishes : tokenFilteredDbDishes,
      nutritionProfile.healthConditions,
      nutritionProfile.dietaryRestrictions.foodPreferences
    );
    const filteredDbDishes = profileFilteredDbDishes;

    const poolAssessment = assessDietPoolSufficiency(filteredDbDishes);
    const allowAIFillInMeals = !!normalizedDiet && poolAssessment.isInsufficient;

    const dishesForPrompt = filteredDbDishes.map((d: any) => ({
      name: d.name,
      category: d.category,
      calories: Number(d.calories ?? d.cal ?? 0),
      protein: Number(d.protein ?? d.pro ?? 0),
      carbs: Number(d.carbs ?? d.carb ?? 0),
      fats: Number(d.fats ?? d.fat ?? 0),
      ingredients: typeof d.ingredients === 'string' ? d.ingredients : (d.ingredients || [])
    }));
    const dishesJson = JSON.stringify(dishesForPrompt);

    const dietConstraint = normalizedDiet ? `\n- Diet Type: ${humanizeDietType(normalizedDiet)}` : '';
    const dietRuleText = getDietPromptRule(normalizedDiet);
    const dietRules = dietRuleText ? `\n- ${dietRuleText}` : '';
    const dietPoolNote = allowAIFillInMeals
      ? `\n- Diet-filtered DB pool is limited (${poolAssessment.reason}); AI may add compliant meals to complete all slots.`
      : '';
    const dishUsageRule = allowAIFillInMeals
      ? '- Prioritize dishes from the list. If list options are insufficient to complete all 7 days under the selected diet, you may add Filipino meals not in the list only for missing slots. Every added meal must include full macros, measured ingredients, and detailed steps.'
      : '- Only use dishes that appear in the list (no new dishes).';

    const prompt = `
You are a professional Filipino nutritionist and meal planner. The user preferences:
- Lifestyle: ${lifestyle}
- Type: ${mealType}
- Goal: ${goal}${dietConstraint}
- Allergies / Avoid: ${humanizeTokens(allRestrictionTokens)}
- Targets: ${targets?.calories ?? 2000} kcal, ${targets?.protein ?? 150}g protein, ${targets?.carbs ?? 250}g carbs, ${targets?.fats ?? 70}g fats
${dietPoolNote}
${buildNutritionProfilePromptBlock(nutritionProfile, targets)}

  ${buildNationalNutritionStandardsBlock(targets)}

Diet-compatible meals from the DB list (JSON):
${dishesJson}

Rules:
- ${dishUsageRule}${dietRules}
- IMPORTANT: For lunch and dinner, include a rice/carb side dish (like "Sinangag na Kanin" or "Fried Rice") to make it a complete Filipino meal.
- Randomize meals across days and avoid repeating the same meal on consecutive days.
- Every meal object must include complete ingredients with specific variants and exact measurements (e.g., "120 g pork tocino", "10 ml canola oil", "1 large chicken egg (50 g)", "240 ml water"). Avoid vague terms like "oil", "meat", "fish", or plain "tocino".
- Cooking instructions must be detailed and practical (4-7 numbered steps) with clear actions and approximate time/heat when relevant.
- Return exactly JSON with "weekPlan": an array of 7 objects with structure:
  { "day":"Monday", "meals": { "breakfast": "Tapsilog"|{name:..., calories:..., ingredients:[]...}, "lunch": {name: "main dish with rice side"}, ... }, "totalCalories": number, "totalProtein": number, "totalCarbs": number, "totalFats": number }
`;

    let weekPlan: any[] = [];
    let preferenceId: number | null = null;

    // Try to get user's preference id early
    try {
      const [prefRows] = await pool.query<any>('SELECT id FROM user_meal_preferences WHERE user_id = ?', [userId]);
      if (Array.isArray(prefRows) && prefRows.length > 0) {
        preferenceId = Number(prefRows[0].id);
      } else {
        preferenceId = await ensureUserPreferenceExists(userId);
      }
    } catch (err: any) {
      // replaced unsafe access with helper
      preferenceId = null;
    }

    // If OpenAI key exists, try AI generation; else fallback immediately
    if (process.env.OPENAI_API_KEY && openaiAvailable) {
      try {
        const completion: any = await safeOpenAICompletionsCreate({
          model: OPENAI_MODEL,
          messages: [
            {
              role: 'system',
              content: allowAIFillInMeals
                ? 'You are a Filipino nutritionist. Prefer the provided list, but if it is insufficient for the selected diet, add compliant meals only to fill missing slots.'
                : 'You are a nutritionist and only use the provided list.'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 4000
        }, 12000);

        const aiResponse = String((completion?.choices?.[0]?.message?.content) ?? '');
        let parsed: any = null;
        try {
          parsed = JSON.parse(aiResponse || '');
        } catch (parseErr: any) {
        }

        if (parsed && Array.isArray(parsed.weekPlan) && parsed.weekPlan.length === 7) {
          weekPlan = await enhanceAIWeekPlanWithDetails(parsed.weekPlan, filteredDbDishes);
          weekPlan = addRiceSidesToMeals(weekPlan); // Add rice sides to complete Filipino meals
          weekPlan = scaleWeekPlanToCalorieTarget(weekPlan, targets);
        } else {
          const aiDay = parsed && parsed.weekPlan && parsed.weekPlan[0] ? parsed.weekPlan[0] : null;
          weekPlan = generateWeekPlan(aiDay, targets, goal, allRestrictionTokens, filteredDbDishes, normalizedDiet);
          weekPlan = addRiceSidesToMeals(weekPlan); // Add rice sides to complete Filipino meals
          weekPlan = scaleWeekPlanToCalorieTarget(weekPlan, targets);
        }
      } catch (aiErr: any) {
        weekPlan = generateWeekPlan(null, targets, goal, allRestrictionTokens, filteredDbDishes, normalizedDiet);
        weekPlan = addRiceSidesToMeals(weekPlan); // Add rice sides to complete Filipino meals
        weekPlan = scaleWeekPlanToCalorieTarget(weekPlan, targets);
      }
    } else {
      weekPlan = generateWeekPlan(null, targets, goal, allRestrictionTokens, filteredDbDishes, normalizedDiet);
      weekPlan = addRiceSidesToMeals(weekPlan); // Add rice sides to complete Filipino meals
      weekPlan = scaleWeekPlanToCalorieTarget(weekPlan, targets);
    }

    if (hasFlatMainVariety(weekPlan)) {
      weekPlan = generateWeekPlan(null, targets, goal, allRestrictionTokens, filteredDbDishes, normalizedDiet);
      weekPlan = addRiceSidesToMeals(weekPlan);
      weekPlan = scaleWeekPlanToCalorieTarget(weekPlan, targets);
    }

    // Build today's shopping list
    let todayShoppingList: any[] = [];
    try {
      const todayName = new Date().toLocaleString('en-US', { weekday: 'long' });
      const todayPlan = weekPlan.find((d: any) => d.day === todayName) || weekPlan[0];
      todayShoppingList = todayPlan ? generateShoppingList([todayPlan]) : [];
    } catch (err: any) {
    }

    // Enrich week plan with recipes (AWAIT this to ensure recipes are included in response)
    try {
      weekPlan = await enrichWeekPlanWithRecipes(weekPlan);
    } catch (err: any) {
    }

    // Final consistency pass: make sure day totals always equal summed meal macros.
    weekPlan = recomputeWeekPlanTotals(weekPlan);
    weekPlan = annotateWeekPlanWithEvidence(weekPlan, nutritionProfile, citationIds);

    const responseMealPlan = {
      weekPlan,
      shoppingList: generateShoppingList(weekPlan),
      todayShoppingList,
      mealPrepTips: getMealPrepTips(weekPlan),
      nutritionTips: getNutritionTips(goal),
      evidenceSummary,
      citations,
      profileSummary: nutritionProfile,
    };

    // Save meal plan safely
    try {
      const safePlanName = planName || "Untitled Plan";

      // ensure we only include generated_at if the column exists
      const hasGeneratedAt = await dbColumnExists('meal_plans', 'generated_at');

      const insertCols = preferenceId === null
        ? (hasGeneratedAt ? 'user_id, plan_name, plan_data, generated_at' : 'user_id, plan_name, plan_data')
        : (hasGeneratedAt ? 'user_id, preference_id, plan_name, plan_data, generated_at' : 'user_id, preference_id, plan_name, plan_data');
  
      const insertValsBase = preferenceId === null
        ? [userId, safePlanName, JSON.stringify(responseMealPlan)]
        : [userId, preferenceId, safePlanName, JSON.stringify(responseMealPlan)];
  
      const insertVals = hasGeneratedAt ? [...insertValsBase, new Date()] : insertValsBase;

      const qMarks = insertVals.map(() => '?').join(', ');
      await pool.query(`INSERT INTO meal_plans (${insertCols}) VALUES (${qMarks})`, insertVals);
    } catch (err: any) {
    }

    // Respond with meal plan
    res.json({
      success: true,
      mealPlan: responseMealPlan,
      saved: !!preferenceId
    });
  } catch (err: any) {
    const errMsg = getErrorMessage(err); // changed
    res.status(500).json({ success: false, message: 'Failed to generate meal plan', error: errMsg });
  }
});

app.post(['/api/meal-planner/regenerate', '/meal-planner/regenerate'], authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    // Accept flexible input shapes:
    const { dayIndex, day, mealType, mealKey, mealTypeKey, mealPlan, planId, excludeMealNames = [], currentMeal, allergies, dietaryRestrictions, targets, goal, lifestyle, diet } = req.body || {};
    const healthConditions = normalizeHealthConditions(req.body?.healthConditions || req.body?.healthCondition);
    const normalizedDietaryRestrictions = normalizeDietaryRestrictions(dietaryRestrictions);
    const inferredDiet = inferDietFromRestrictions(normalizedDietaryRestrictions);

    const allergyTokens = normalizeSelectionList(allergies);
    const deprecatedRestrictionTokens = normalizeSelectionList(dietaryRestrictions);
    const profileRestrictionTokens = getRestrictionTokensFromProfile(normalizedDietaryRestrictions, healthConditions);
    const allRestrictionTokens = Array.from(new Set([...allergyTokens, ...deprecatedRestrictionTokens, ...profileRestrictionTokens]));
    const normalizedDiet = normalizeDietType(diet || inferredDiet);
    const nutritionProfile = normalizeMealPlannerProfile(
      { ...(req.body || {}), healthConditions, dietaryRestrictions: normalizedDietaryRestrictions },
      normalizedDiet,
      allRestrictionTokens
    );
    const citationIds = getCitationIdsForProfile(nutritionProfile, allergyTokens.length > 0);

    // Determine category for dish selection
    const category = mealTypeKey || mealType || mealKey || null;
    const normalizedCategory = (category === 'snack1' || category === 'snack2') ? 'snacks' : category;
    const isSnack = normalizedCategory === 'snacks';

    const toFiniteNumber = (value: any, fallback: number) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    };
    const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

    const dailyTarget = clamp(toFiniteNumber(targets?.calories, 2000), 800, 5000);

    // Compute how many calories this regenerated meal should aim for.
    // If we have the current week plan/day, compute remaining calories after other meals.
    const computeDesiredMealCalories = () => {
      const idx = Number(dayIndex);
      const key = String(category || '').toLowerCase().trim();
      const keyNorm = (key === 'snack1' || key === 'snack2') ? 'snacks' : key;

      const distributionFallback = () => {
        if (keyNorm === 'breakfast') return dailyTarget * 0.25;
        if (keyNorm === 'lunch') return dailyTarget * 0.30;
        if (keyNorm === 'dinner') return dailyTarget * 0.30;
        // snacks
        return dailyTarget * 0.075;
      };

      if (!Array.isArray(mealPlan) || !Number.isFinite(idx) || idx < 0 || idx >= mealPlan.length) {
        return clamp(Math.round(distributionFallback()), 100, dailyTarget);
      }

      const dayObj = mealPlan[idx];
      const meals = dayObj?.meals && typeof dayObj.meals === 'object' ? dayObj.meals : null;
      if (!meals) return clamp(Math.round(distributionFallback()), 100, dailyTarget);

      // Exclude the meal we're regenerating from the "other" sum.
      const regenKey = String(mealTypeKey || mealType || mealKey || '').trim();
      const otherMeals = Object.entries(meals).filter(([k]) => String(k).trim() !== regenKey).map(([, v]) => v);
      const otherTotals = sumMacros(otherMeals as any[]);
      const remaining = dailyTarget - Number(otherTotals.calories || 0);
      return clamp(Math.round(remaining), 100, dailyTarget);
    };

    const desiredMealCalories = computeDesiredMealCalories();

    const addRiceSideToSingleMealIfMissing = (mealObj: any) => {
      const cat = String(normalizedCategory || '').toLowerCase().trim();
      if (cat !== 'lunch' && cat !== 'dinner') return mealObj;

      const name = String(mealObj?.name || '').toLowerCase();
      if (name.includes('rice')) return mealObj;

      const riceSideDishes = [
        { name: 'Sinangag na Kanin (Garlic Fried Rice)', calories: 180, carbs: 35, protein: 4, fats: 2 },
        { name: 'Plain Steamed Rice', calories: 130, carbs: 28, protein: 2.7, fats: 0.3 },
        { name: 'Fried Rice', calories: 160, carbs: 30, protein: 3, fats: 3 }
      ];
      const randomRice = riceSideDishes[Math.floor(Math.random() * riceSideDishes.length)];

      const updated = {
        ...mealObj,
        name: `${mealObj.name} with ${randomRice.name}`,
        carbs: (mealObj.carbs || 0) + randomRice.carbs,
        protein: (mealObj.protein || 0) + randomRice.protein,
        fats: (mealObj.fats || 0) + randomRice.fats,
        ingredients: Array.isArray(mealObj.ingredients)
          ? [...mealObj.ingredients, 'Garlic Fried Rice or Steamed Rice']
          : ['Garlic Fried Rice or Steamed Rice']
      };

      updated.calories = caloriesFromMacrosWithFallback(updated);

      return updated;
    };

    const scaleMealToDesiredCalories = (mealObj: any) => {
      const cur = Number(mealObj?.calories || 0);
      if (!Number.isFinite(cur) || cur <= 0) return mealObj;
      const ratioRaw = desiredMealCalories / cur;
      if (Math.abs(1 - ratioRaw) <= 0.08) return mealObj;
      const ratio = clamp(ratioRaw, 0.6, 2.2);
      return scaleMealPortion(mealObj, ratio);
    };

    const attachEvidenceToMeal = (mealObj: any) => {
      const suitability = buildMealSuitability(mealObj, nutritionProfile, citationIds);
      return {
        ...mealObj,
        suitabilityNotes: suitability.suitabilityNotes,
        citationIds: suitability.citationIds,
      };
    };

    // Get dishes by category if category provided else fetch all
    let dishes: any[] = [];
    
    // Use snacks list if this is a snack regeneration
    if (isSnack) {
      dishes = filipinoSnacks;
    } else if (normalizedCategory) {
      const [rows] = await pool.query<any>('SELECT * FROM filipino_dishes WHERE category = ?', [normalizedCategory]);
      dishes = rows || [];
    }
    
    if (!Array.isArray(dishes) || dishes.length === 0) {
      if (isSnack) {
        dishes = filipinoSnacks;
      } else {
        const [rows] = await pool.query<any>('SELECT * FROM filipino_dishes ORDER BY name');
        dishes = rows || [];
      }
    }

    // Normalize excluded names (lowercase)
    const excludeArr = (Array.isArray(excludeMealNames) ? excludeMealNames : (excludeMealNames ? [excludeMealNames] : []))
      .concat(currentMeal && typeof currentMeal === 'string' ? [currentMeal] : (currentMeal && currentMeal.name ? [currentMeal.name] : []))
      .map((n: any) => String(n || '').toLowerCase().trim())
      .filter(Boolean);

    // Fallback sample if no DB dishes
    if (!Array.isArray(dishes) || dishes.length === 0) {
      const fallbackSourceByTokens = isSnack
        ? filterDishesByTokens(filipinoSnacks, allRestrictionTokens)
        : filterDishesByTokens(trustedFilipinoMealsDetailed, allRestrictionTokens);
      const fallbackSourceByDiet = filterDishesByDiet(fallbackSourceByTokens, normalizedDiet);
      const fallbackSource = normalizedDiet ? fallbackSourceByDiet : fallbackSourceByTokens;

      const fallbackDish = Array.isArray(fallbackSource) && fallbackSource.length > 0
        ? fallbackSource[Math.floor(Math.random() * fallbackSource.length)]
        : null;
      const mealObj = fallbackDish
        ? createMealObject(fallbackDish)
        : buildDietFallbackMeal(
            isSnack ? 'snack1' : String(normalizedCategory || 'lunch'),
            normalizedDiet,
            desiredMealCalories,
            allRestrictionTokens
          );
      const pkg = await generateRecipePackage(mealObj.name, mealObj.ingredients);
      return res.json({ success: true, newMeal: attachEvidenceToMeal({ ...mealObj, ingredients: pkg.ingredients, recipe: pkg.recipe }), source: 'fallback' });
    }

    // Apply best-effort filtering for fallback picks
    const candidateByTokens = filterDishesByTokens(dishes, allRestrictionTokens);
    const candidateByDiet = filterDishesByDiet(candidateByTokens, normalizedDiet);
    const candidateDishes = filterDishesByHealthProfile(
      normalizedDiet ? candidateByDiet : candidateByTokens,
      nutritionProfile.healthConditions,
      nutritionProfile.dietaryRestrictions.foodPreferences
    );
    const allowAiFillInMeal = !!normalizedDiet && candidateDishes.length < 2;

    // Helper: pick random excluding excludeArr
    function pickRandomExcluding(list: any[], exclude: string[]) {
      if (!Array.isArray(list) || list.length === 0) return null;
      const pool = list.filter(d => !exclude.includes(String(d.name || '').toLowerCase().trim()));
      if (pool.length === 0) {
        // if nothing left, pick random and label alt
        const r = list[Math.floor(Math.random() * list.length)];
        return { ...r, name: `${r.name} (Alt)` };
      }
      return pool[Math.floor(Math.random() * pool.length)];
    }

    // Build prompt for AI if needed
    const dishListJson = JSON.stringify(candidateDishes.map(d => ({ name: d.name, calories: d.calories, protein: d.protein, carbs: d.carbs, fats: d.fats })));
    const excludeText = excludeArr.length > 0 ? `\nDo NOT return these dish names: ${excludeArr.join(', ')}` : '';
    const dietRuleText = getDietPromptRule(normalizedDiet);
    const listRule = allowAiFillInMeal
      ? 'Prefer the list below. If none of them fit the selected diet and constraints, you may create ONE Filipino meal that still follows the diet, targets, and allergies.'
      : 'Choose only from the list below.';
    const prompt = `
You are a Filipino nutritionist. Choose a single ${isSnack ? 'snack' : String(category || mealType || 'meal')} best suited for the user.
User targets: ${targets?.calories ?? 2000} kcal, ${targets?.protein ?? 150}g protein, ${targets?.carbs ?? 250}g carbs, ${targets?.fats ?? 70}g fats.
Aim for around ${desiredMealCalories} kcal for THIS regenerated ${isSnack ? 'snack' : 'meal'} so the whole day stays near the daily target.
  Diet type: ${humanizeDietType(normalizedDiet)}.
  Diet rule: ${dietRuleText || 'No strict diet rule.'}
  Allergies / Avoid: ${humanizeTokens(allRestrictionTokens)}.
${buildNutritionProfilePromptBlock(nutritionProfile, targets)}
${listRule}
${buildNationalNutritionStandardsBlock(targets)}
${excludeText}
List: ${dishListJson}
Return JSON: { "newMeal": { "name":"...", "ingredients":[...], "calories":..., "protein":..., "carbs":..., "fats":..., "recipe":"..." } }
Ingredient rules: include exact metric amounts and specific ingredient variants (e.g., pork/chicken/beef tocino, canola/vegetable oil). No vague ingredients.
Instruction rules: 4-7 numbered steps with actionable details and approximate times.
`;

    // Try OpenAI for regeneration
    if (process.env.OPENAI_API_KEY && openaiAvailable) {
      try {
        const completion: any = await safeOpenAICompletionsCreate({
          model: OPENAI_MODEL,
          messages: [
            { role: 'system', content: allowAiFillInMeal ? 'You are a Filipino nutritionist. Prefer provided list; if insufficient, add one compliant meal.' : 'You are a Filipino nutritionist. Use only provided list.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
          max_tokens: 700
        }, 8000);

        const aiResponse = String((completion?.choices?.[0]?.message?.content) ?? '{}');
        let parsed: any = null;
        try { 
          parsed = JSON.parse(aiResponse); 
        } catch (parseErr) {
          // AI response was not valid JSON � will use fallback
          parsed = null;
        }

        if (parsed && parsed.newMeal && parsed.newMeal.name) {
          const nameLower = String(parsed.newMeal.name).toLowerCase().trim();
          // If AI returns excluded name, fallback
          if (excludeArr.includes(nameLower)) {
            const picked = pickRandomExcluding(candidateDishes, excludeArr);
            let mealObj: any = picked
              ? createMealObject(picked)
              : buildDietFallbackMeal(
                  isSnack ? 'snack1' : String(normalizedCategory || 'lunch'),
                  normalizedDiet,
                  desiredMealCalories,
                  allRestrictionTokens
                );
            mealObj = addRiceSideToSingleMealIfMissing(mealObj);
            mealObj = scaleMealToDesiredCalories(mealObj);
            const pkg = await generateRecipePackage(mealObj.name, mealObj.ingredients);
            return res.json({ success: true, newMeal: attachEvidenceToMeal({ ...mealObj, ingredients: pkg.ingredients, recipe: pkg.recipe }), source: 'fallback-excluded' });
          }
          // If DB contains this dish, use DB result for accurate macros
          const found = candidateDishes.find(d => String(d.name || '').toLowerCase().trim() === nameLower);
          if (found) {
            let mealObj: any = createMealObject(found);
            mealObj = addRiceSideToSingleMealIfMissing(mealObj);
            mealObj = scaleMealToDesiredCalories(mealObj);
            const pkg = await generateRecipePackage(mealObj.name, mealObj.ingredients);
            return res.json({ success: true, newMeal: attachEvidenceToMeal({ ...mealObj, ingredients: pkg.ingredients, recipe: pkg.recipe }), source: 'ai' });
          }
          let mealObj: any = createMealObject(parsed.newMeal);
          mealObj = addRiceSideToSingleMealIfMissing(mealObj);
          mealObj = scaleMealToDesiredCalories(mealObj);
          const pkg = await generateRecipePackage(mealObj.name, mealObj.ingredients);
          return res.json({ success: true, newMeal: attachEvidenceToMeal({ ...mealObj, ingredients: pkg.ingredients, recipe: pkg.recipe }), source: 'ai' });
        }
      } catch (err: any) {
      }
    }

    // fallback deterministic-ish pick that avoids excluded names and tries to fit the calorie budget
    const pickClosestExcluding = (list: any[], exclude: string[], desiredCalories: number) => {
      const pool = list.filter(d => !exclude.includes(String(d.name || '').toLowerCase().trim()));
      const usePool = pool.length > 0 ? pool : list;
      if (!Array.isArray(usePool) || usePool.length === 0) return null;

      let best = usePool[0];
      let bestDiff = Math.abs(toFiniteNumber(best?.calories ?? best?.cal ?? 0, 0) - desiredCalories);
      for (const d of usePool) {
        const cals = toFiniteNumber(d?.calories ?? d?.cal ?? 0, 0);
        const diff = Math.abs(cals - desiredCalories);
        if (diff < bestDiff) {
          best = d;
          bestDiff = diff;
        }
      }
      return best;
    };

    const picked = pickClosestExcluding(candidateDishes, excludeArr, desiredMealCalories) || pickRandomExcluding(candidateDishes, excludeArr);
    let mealObj: any = picked
      ? createMealObject(picked)
      : buildDietFallbackMeal(
          isSnack ? 'snack1' : String(normalizedCategory || 'lunch'),
          normalizedDiet,
          desiredMealCalories,
          allRestrictionTokens
        );
    mealObj = addRiceSideToSingleMealIfMissing(mealObj);
    mealObj = scaleMealToDesiredCalories(mealObj);
    const pkg = await generateRecipePackage(mealObj.name, mealObj.ingredients);
    return res.json({ success: true, newMeal: attachEvidenceToMeal({ ...mealObj, ingredients: pkg.ingredients, recipe: pkg.recipe }), source: 'fallback' });

  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Regenerate failed', error: getErrorMessage(err) });
  }
});

// helper to check if a column exists in a table (returns boolean)
async function dbColumnExists(table: string, column: string): Promise<boolean> {
  try {
    const dbName = process.env.DB_NAME || 'activecore';
    const schema = (process.env.DB_SCHEMA || '').trim() || 'public';
    const [rows] = await pool.query<any>(
      `SELECT COUNT(*) as cnt 
       FROM information_schema.COLUMNS 
       WHERE TABLE_NAME = ? AND COLUMN_NAME = ?
         AND (TABLE_SCHEMA = ? OR TABLE_SCHEMA = ? OR TABLE_SCHEMA = 'public')`,
      [table, column, schema, dbName]
    );
    return !!(rows && rows[0] && Number(rows[0].cnt) > 0);
  } catch (err: any) {
    return false;
  }
}

// ===== MEAL-PLANNER: Save (create/update) - tolerant to generated_at/updated_at schema =====
app.post('/api/meal-planner/save', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { planId, planName, mealPlan } = req.body;

    const incomingWeekPlan = Array.isArray(mealPlan) ? mealPlan : mealPlan?.weekPlan;

    if (!incomingWeekPlan || !Array.isArray(incomingWeekPlan)) {
      return res.status(400).json({ success: false, message: 'Invalid mealPlan payload' });
    }

    const normalizedWeekPlan = recomputeWeekPlanTotals(incomingWeekPlan);
    const planPayload = Array.isArray(mealPlan)
      ? { weekPlan: normalizedWeekPlan }
      : { ...(mealPlan || {}), weekPlan: normalizedWeekPlan };

    // ensure preference exists if needed (unchanged)
    let preferenceId: number | null = null;
    try {
      const [prefRows] = await pool.query<any>('SELECT id FROM user_meal_preferences WHERE user_id = ?', [userId]);
      if (Array.isArray(prefRows) && prefRows.length > 0) {
        preferenceId = Number(prefRows[0].id);
      } else {
        preferenceId = await ensureUserPreferenceExists(userId);
      }
    } catch (err: any) {
      preferenceId = null;
    }

    // Update (if planId provided) - use schema-aware column usage
    if (planId) {
      const hasUpdatedAt = await dbColumnExists('meal_plans', 'updated_at');
      try {
        if (hasUpdatedAt) {
          await pool.query('UPDATE meal_plans SET plan_name = ?, plan_data = ?, updated_at = NOW() WHERE id = ?', [
            planName || null, JSON.stringify(planPayload), planId
          ]);
        } else {
          await pool.query('UPDATE meal_plans SET plan_name = ?, plan_data = ? WHERE id = ?', [
            planName || null, JSON.stringify(planPayload), planId
          ]);
        }

        return res.json({ success: true, message: 'Meal plan updated', planId });
      } catch (updateErr: any) {
        return res.status(500).json({ success: false, message: 'Failed to update meal plan', error: getErrorMessage(updateErr) });
      }
    }

    // Insert new plan - handle generated_at if present
    try {
      const hasGeneratedAt = await dbColumnExists('meal_plans', 'generated_at');

      const insertCols = preferenceId === null
        ? (hasGeneratedAt ? 'user_id, plan_name, plan_data, generated_at' : 'user_id, plan_name, plan_data')
        : (hasGeneratedAt ? 'user_id, preference_id, plan_name, plan_data, generated_at' : 'user_id, preference_id, plan_name, plan_data');

      const insertValsBase = preferenceId === null
        ? [userId, planName || null, JSON.stringify(planPayload)]
        : [userId, preferenceId, planName || null, JSON.stringify(planPayload)];

      const insertVals = hasGeneratedAt ? [...insertValsBase, new Date()] : insertValsBase;

      const qMarks = insertVals.map(() => '?').join(', ');
      const [result] = await pool.query<any>(`INSERT INTO meal_plans (${insertCols}) VALUES (${qMarks})`, insertVals);
      const newId = (result as any)?.insertId || null;
      return res.status(201).json({ success: true, message: 'Meal plan saved', planId: newId });
    } catch (insertErr: any) {
      return res.status(500).json({ success: false, message: 'Failed to save meal plan', error: getErrorMessage(insertErr) });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Failed to save meal plan', error: getErrorMessage(err) });
  }
});

// ===== MEAL-PLANNER: List plans - schema-safe columns only =====
app.get('/api/meal-planner/plans', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const hasUpdatedAt = await dbColumnExists('meal_plans', 'updated_at');
    const hasGeneratedAt = await dbColumnExists('meal_plans', 'generated_at');

    const cols = ['id', 'plan_name', 'plan_data'];
    if (hasGeneratedAt) cols.push('generated_at');
    if (hasUpdatedAt) cols.push('updated_at');

    const orderBy = hasGeneratedAt ? 'generated_at' : 'id';
    const [rows] = await pool.query<any>(`SELECT ${cols.join(', ')} FROM meal_plans WHERE user_id = ? ORDER BY ${orderBy} DESC`, [userId]);

    const plans = rows.map((r: any) => ({
      id: Number(r.id),
      planName: r.plan_name ?? null,
      plan_data: typeof r.plan_data === 'string' ? (() => { try { return JSON.parse(r.plan_data); } catch { return r.plan_data; } })() : r.plan_data ?? null,
      generatedAt: r.generated_at ?? null,
      updatedAt: r.updated_at ?? r.generated_at ?? null
    }));

    res.json({ success: true, plans });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to list meal plans', error: getErrorMessage(err) });
  }
});

// ===== MEAL-PLANNER: Load plan by id - schema-safe =====
app.get('/api/meal-planner/plans/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const planId = Number(req.params.id);

    const hasUpdatedAt = await dbColumnExists('meal_plans', 'updated_at');
    const hasGeneratedAt = await dbColumnExists('meal_plans', 'generated_at');

    const cols = ['id', 'user_id', 'plan_name', 'plan_data'];
    if (hasGeneratedAt) cols.push('generated_at');
    if (hasUpdatedAt) cols.push('updated_at');

    const [rows] = await pool.query<any>(`SELECT ${cols.join(', ')} FROM meal_plans WHERE id = ?`, [planId]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    const plan = rows[0];
    if (Number(plan.user_id) !== userId && (req.user?.role ?? '') !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden: not the owner' });
    }

    let parsed = null;
    if (typeof plan.plan_data === 'string') {
      try { 
        parsed = JSON.parse(plan.plan_data); 
      } catch (parseErr) {
        // plan.plan_data was not valid JSON � treating as fallback
        parsed = plan.plan_data;
      }
    } else {
      parsed = plan.plan_data;
    }

    res.json({
      success: true,
      plan: {
        id: plan.id,
        name: plan.plan_name,
        generatedAt: plan.generated_at ?? null,
        updatedAt: plan.updated_at ?? plan.generated_at ?? null,
        data: parsed,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to load meal plan', error: getErrorMessage(err) });
  }
});

// ===== MEAL-PLANNER: Delete plan (owner or admin) - minimal columns, no updated_at =====
app.delete('/api/meal-planner/plans/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const planId = Number(req.params.id);

    // verify existence & owner (select minimal columns)
    const [rows] = await pool.query<any>('SELECT id, user_id FROM meal_plans WHERE id = ?', [planId]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    const ownerId = Number(rows[0].user_id);
    const isOwner = ownerId === userId;
    const isAdmin = (req.user?.role || '') === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Forbidden: not the owner' });
    }

    await pool.query('DELETE FROM meal_plans WHERE id = ?', [planId]);
    return res.json({ success: true, message: 'Plan deleted' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Failed to delete meal plan', error: getErrorMessage(err) });
  }
});

// QR Attendance Check-in Route
app.post('/api/attendance/checkin', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { qrToken, location } = req.body;

    const normalizedToken = typeof qrToken === 'string' ? qrToken.trim() : '';
    if (!normalizedToken) {
      return res.status(400).json({ success: false, message: 'Invalid QR code.' });
    }

    // Validate QR token against DB (active + not expired)
    const [tokenRows] = await pool.query<any>(
      'SELECT id, token, expires_at, is_active FROM qr_attendance_tokens WHERE token = ? AND is_active = TRUE AND expires_at > NOW() LIMIT 1',
      [normalizedToken]
    );

    if (!tokenRows || tokenRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid QR code.' });
    }

    const tokenId = Number(tokenRows[0].id);

    // Prevent duplicate check-in for today (PH time)
    const PH_TZ = 'Asia/Manila';
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: PH_TZ });
    const [existing] = await pool.query<any>(
     
      `SELECT id FROM attendance WHERE user_id = ? AND DATE(check_in_time) = ?`,
      [userId, todayStr]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: "Already checked in today." });
    }

    // Insert attendance record

    const [inserted] = await pool.query<any>(
      "INSERT INTO attendance (user_id, check_in_time, location, status, qr_token_id) VALUES (?, NOW(), ?, 'present', ?) RETURNING id, check_in_time, location, status",
      [userId, location || 'Main Gym', tokenId]
    );

    const attendanceRow = inserted?.[0];
    const checkInTimeStr = attendanceRow?.check_in_time
      ? (attendanceRow.check_in_time instanceof Date ? attendanceRow.check_in_time.toISOString() : String(attendanceRow.check_in_time))
      : new Date().toISOString();

    // Total attendance count
    const [countRows] = await pool.query<any>('SELECT COUNT(*)::int AS count FROM attendance WHERE user_id = ?', [userId]);
    const totalAttendance = Number(countRows?.[0]?.count ?? 0);

    // Streak based on distinct attendance days (consecutive days ending today)
    const [dayRows] = await pool.query<any>(
      'SELECT DISTINCT DATE(check_in_time) AS day FROM attendance WHERE user_id = ? ORDER BY day DESC LIMIT 120',
      [userId]
    );
    const days: string[] = (dayRows || []).map((r: any) => String(r.day));
    let streak = 0;
    if (days.length > 0) {
      let prev = new Date(days[0] + 'T00:00:00Z');
      streak = 1;
      for (let i = 1; i < days.length; i++) {
        const current = new Date(days[i] + 'T00:00:00Z');
        const diffDays = Math.round((prev.getTime() - current.getTime()) / (24 * 60 * 60 * 1000));
        if (diffDays === 1) {
          streak++;
          prev = current;
        } else {
          break;
        }
      }
    }

    return res.json({
      success: true,
      message: 'Check-in successful.',
      attendance: {
        id: attendanceRow?.id,
        checkInTime: checkInTimeStr,
        location: attendanceRow?.location ?? (location || 'Main Gym'),
        status: attendanceRow?.status ?? 'present',
      },
      streak,
      totalAttendance,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Failed to record attendance." });
  }
});

// Member Attendance History Route
app.get('/api/attendance/history', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const PH_TZ = 'Asia/Manila';
    const [rows] = await pool.query<any>(
      `SELECT id, check_in_time, location, status FROM attendance WHERE user_id = ? ORDER BY check_in_time DESC`,
      [userId]
    );

    // Format for frontend
    const attendance = rows.map(r => {
      // Ensure check_in_time is a string in ISO format
      let checkInTimeStr: string;
      if (typeof r.check_in_time === 'string') {
        checkInTimeStr = r.check_in_time;
      } else if (r.check_in_time instanceof Date) {
        checkInTimeStr = r.check_in_time.toISOString();
      } else {
        checkInTimeStr = String(r.check_in_time);
      }
      return {
        id: r.id,
        checkInTime: checkInTimeStr,
        location: r.location,
        status: r.status,
      };
    });

    // Calculate stats
    let currentStreak = 0;
    let prevDate = null;
    for (const record of attendance) {
      const date = new Date(record.checkInTime).toLocaleDateString('en-CA', { timeZone: PH_TZ });
      if (!prevDate) {
        prevDate = date;
        currentStreak = 1;
      } else {
        const prev = new Date(prevDate);
        const curr = new Date(date);
        prev.setDate(prev.getDate() - 1);
        if (curr.toISOString().split('T')[0] === prev.toISOString().split('T')[0]) {
          currentStreak++;
          prevDate = date;
        } else {
          break;
        }
      }
    }

    res.json({
      success: true,
      attendance,
      stats: {
        totalAttendance: attendance.length,
        currentStreak
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Failed to fetch attendance history." });
  }
});

// Member Absence Status Route (for reminders/notifications)
app.get('/api/attendance/absence-status', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const thresholdDaysRaw = req.query.thresholdDays as string | undefined;
    const thresholdDays = Math.max(1, Number.isFinite(Number(thresholdDaysRaw)) ? Number(thresholdDaysRaw) : 3);

    const [rows] = await pool.query<any>(
      `SELECT
         DATE(MAX(check_in_time)) AS last_day,
         CASE
           WHEN MAX(check_in_time) IS NULL THEN NULL
           ELSE (CURRENT_DATE - DATE(MAX(check_in_time)))::int
         END AS days_since
       FROM attendance
       WHERE user_id = ?`,
      [userId]
    );

    const lastDay: string | null = rows?.[0]?.last_day ? String(rows[0].last_day) : null;
    const daysSinceLastAttendance: number | null =
      rows?.[0]?.days_since === null || rows?.[0]?.days_since === undefined ? null : Number(rows[0].days_since);

    const isAbsent = lastDay === null ? true : (daysSinceLastAttendance ?? 0) >= thresholdDays;

    return res.json({
      success: true,
      lastAttendanceDate: lastDay,
      daysSinceLastAttendance,
      thresholdDays,
      isAbsent,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Failed to fetch absence status.', error: getErrorMessage(err) });
  }
});

// Admin: Who is present today
app.get('/api/admin/attendance/today', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    const [rows] = await pool.query<any>(
      `SELECT a.id, a.user_id, a.check_in_time, a.location, u.first_name, u.last_name, u.email
       FROM attendance a
       INNER JOIN users u ON a.user_id = u.id
       WHERE DATE(a.check_in_time) = ?
       ORDER BY a.check_in_time DESC`,
      [today]
    );
    res.json({ success: true, present: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Failed to fetch today's attendance." });
  }
});

app.get('/api/admin/attendance', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const PH_TZ = 'Asia/Manila';
    const date = (req.query.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: PH_TZ });
    const [rows] = await pool.query<any>(
      `SELECT a.id, a.user_id, a.check_in_time, a.location, u.first_name, u.last_name, u.email
       FROM attendance a
       INNER JOIN users u ON a.user_id = u.id
       WHERE DATE(a.check_in_time) = ?
       ORDER BY a.check_in_time DESC`,
      [date]
    );
    // Format for frontend
    const attendance = rows.map(r => {
      const checkInTimeStr =
        typeof r.check_in_time === 'string'
          ? r.check_in_time
          : (r.check_in_time instanceof Date ? r.check_in_time.toISOString() : String(r.check_in_time));
      return {
        id: r.id,
        userId: r.user_id,
        fullName: `${r.first_name} ${r.last_name}`,
        email: r.email,
        checkInTime: checkInTimeStr,
        location: r.location,
        status: "present"
      };
    });
    res.json({ success: true, attendance });
  } catch (err: any) {
    res.status(500).json({ success: false, message: "Failed to fetch attendance." });
  }
});

// --- Rewards: Available ---
app.get('/api/rewards/available', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    // Example rewards (customize as needed)
    const rewards = [
      { id: 1, title: "Bronze Streak", description: "Attend 3 days", requiredAttendance: 3, points: 10, category: "streak", icon: "🥉" },
      { id: 2, title: "Silver Streak", description: "Attend 7 days", requiredAttendance: 7, points: 25, category: "streak", icon: "🥈" },
      { id: 3, title: "Gold Streak", description: "Attend 14 days", requiredAttendance: 14, points: 50, category: "streak", icon: "🥇" },
      { id: 4, title: "Attendance Pro", description: "Attend 30 days", requiredAttendance: 30, points: 100, category: "streak", icon: "🏆" },
    ];

    // Fetch claimed rewards
    let claimedRows: any[] = [];
    try {
      const [rows] = await pool.query<any>(
        `SELECT reward_id, claimed_at FROM user_rewards WHERE user_id = ?`,
        [userId]
      );
      claimedRows = rows;
    } catch (e) {
      // Backward compat: some deployments used `rewards_claimed`
      const [rows] = await pool.query<any>(
        `SELECT reward_id, claimed_at FROM rewards_claimed WHERE user_id = ?`,
        [userId]
      );
      claimedRows = rows;
    }
    const claimedMap = new Map<number, string>();
    claimedRows.forEach(r => claimedMap.set(r.reward_id, r.claimed_at));

    // Fetch attendance count
    const [attendanceRows] = await pool.query<any>(
      `SELECT COUNT(*) as total FROM attendance WHERE user_id = ?`,
      [userId]
    );
    const totalAttendance = attendanceRows[0]?.total || 0;

    // Mark rewards as claimed/unlocked
    const rewardsWithStatus = rewards.map(r => ({
      ...r,
      claimed: claimedMap.has(r.id),
      claimedAt: claimedMap.get(r.id) || null,
      unlocked: totalAttendance >= r.requiredAttendance
    }));

    res.json({ success: true, rewards: rewardsWithStatus });
  } catch (err: any) {
    console.error('Failed to fetch rewards:', err);
    res.status(500).json({ success: false, message: "Failed to fetch rewards." });
  }
});

// --- Rewards: Claim ---
app.post('/api/rewards/claim', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { rewardId } = req.body;
    if (!rewardId) return res.status(400).json({ success: false, message: "Missing rewardId" });

    // Example rewards (should match above)
    const rewards = [
      { id: 1, requiredAttendance: 3 },
      { id: 2, requiredAttendance: 7 },
      { id: 3, requiredAttendance: 14 },
      { id: 4, requiredAttendance: 30 },
    ];
    const reward = rewards.find(r => r.id === rewardId);
    if (!reward) return res.status(404).json({ success: false, message: "Reward not found" });

    // Check attendance
    const [attendanceRows] = await pool.query<any>(
      `SELECT COUNT(*) as total FROM attendance WHERE user_id = ?`,
      [userId]
    );
    const totalAttendance = attendanceRows[0]?.total || 0;
    if (totalAttendance < reward.requiredAttendance) {
      return res.status(400).json({ success: false, message: "Not enough attendance to claim this reward." });
    }

    // Check if already claimed
    let claimedRows: any[] = [];
    try {
      const [rows] = await pool.query<any>(
        `SELECT id FROM user_rewards WHERE user_id = ? AND reward_id = ?`,
        [userId, rewardId]
      );
      claimedRows = rows;
    } catch (e) {
      const [rows] = await pool.query<any>(
        `SELECT id FROM rewards_claimed WHERE user_id = ? AND reward_id = ?`,
        [userId, rewardId]
      );
      claimedRows = rows;
    }
    if (claimedRows.length > 0) {
      return res.status(400).json({ success: false, message: "Reward already claimed." });
    }

    // Insert claim
    try {
      await pool.query(
        `INSERT INTO user_rewards (user_id, reward_id, claimed_at) VALUES (?, ?, NOW())`,
        [userId, rewardId]
      );
    } catch (e) {
      await pool.query(
        `INSERT INTO rewards_claimed (user_id, reward_id, claimed_at) VALUES (?, ?, NOW())`,
        [userId, rewardId]
      );
    }

    res.json({ success: true, message: "Reward claimed!" });
  } catch (err: any) {
    console.error('Failed to claim reward:', err);
    res.status(500).json({ success: false, message: "Failed to claim reward." });
  }
});

// User Profile Route (for QR Attendance)
app.get('/api/user/profile', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const [users] = await pool.query<any>(
      'SELECT id, email, first_name, last_name, role FROM users WHERE id = ?',
      [userId]
    );
    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const user = users[0];
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch user profile.' });
  }
});

app.put('/api/user/profile', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const firstNameRaw = req.body?.firstName;
    const lastNameRaw = req.body?.lastName;
    const usernameRaw = req.body?.username ?? req.body?.email;

    const updates: string[] = [];
    const values: any[] = [];

    if (typeof firstNameRaw === 'string') {
      const firstName = sanitizeInput(firstNameRaw);
      if (!firstName) {
        return res.status(400).json({ success: false, message: 'First name cannot be empty.' });
      }
      updates.push('first_name = ?');
      values.push(firstName);
    }

    if (typeof lastNameRaw === 'string') {
      const lastName = sanitizeInput(lastNameRaw);
      if (!lastName) {
        return res.status(400).json({ success: false, message: 'Last name cannot be empty.' });
      }
      updates.push('last_name = ?');
      values.push(lastName);
    }

    if (typeof usernameRaw === 'string') {
      const username = sanitizeInput(usernameRaw);
      if (!username) {
        return res.status(400).json({ success: false, message: 'Username cannot be empty.' });
      }

      const [existing] = await pool.query<any>(
        'SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id <> ? LIMIT 1',
        [username, userId]
      );
      if (Array.isArray(existing) && existing.length > 0) {
        return res.status(409).json({ success: false, message: 'Username is already in use.' });
      }

      updates.push('email = ?');
      values.push(username);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No profile fields were provided.' });
    }

    values.push(userId);
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

    const [users] = await pool.query<any>(
      'SELECT id, email, first_name, last_name, role FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    const user = Array.isArray(users) && users.length > 0 ? users[0] : null;
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: {
        id: user.id,
        email: user.email,
        username: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
});

app.post('/api/user/change-password', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new password are required.' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, message: 'New password must be different from current password.' });
    }

    const pwValidation = validatePassword(newPassword);
    if (!pwValidation.isValid) {
      return res.status(400).json({ success: false, message: pwValidation.message || 'New password is too weak.' });
    }

    const [users] = await pool.query<any>('SELECT id, password FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = users[0];
    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: 'Failed to update password.' });
  }
});

// ============================================
// USER SETTINGS: Absence reminder (per-user)
// ============================================

app.get('/api/user/settings/absence-reminder', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const [rows] = await pool.query<any>(
      'SELECT enabled, threshold_days, reminder_hour, reminder_minute FROM user_absence_reminder_settings WHERE user_id = ? LIMIT 1',
      [userId]
    );

    const row = rows?.[0];
    if (!row) {
      return res.json({
        success: true,
        settings: { enabled: true, thresholdDays: 3, reminderHour: 8, reminderMinute: 0 },
      });
    }

    res.json({
      success: true,
      settings: {
        enabled: row.enabled === true || row.enabled === 1 || row.enabled === '1',
        thresholdDays: Number(row.threshold_days) || 3,
        reminderHour: Number(row.reminder_hour) || 8,
        reminderMinute: Number(row.reminder_minute) || 0,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to load absence reminder settings.' });
  }
});

app.post('/api/user/settings/absence-reminder', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const enabled = Boolean(req.body?.enabled);
    const thresholdDays = Math.max(1, Number(req.body?.thresholdDays ?? 3));
    const reminderHour = Math.min(23, Math.max(0, Number(req.body?.reminderHour ?? 8)));
    const reminderMinute = Math.min(59, Math.max(0, Number(req.body?.reminderMinute ?? 0)));

    // Prefer PostgreSQL upsert.
    try {
      await pool.query(
        `INSERT INTO user_absence_reminder_settings (user_id, enabled, threshold_days, reminder_hour, reminder_minute, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET enabled = EXCLUDED.enabled, threshold_days = EXCLUDED.threshold_days, reminder_hour = EXCLUDED.reminder_hour, reminder_minute = EXCLUDED.reminder_minute, updated_at = NOW()`,
        [userId, enabled, thresholdDays, reminderHour, reminderMinute]
      );
    } catch (e: any) {
      // MySQL fallback.
      await pool.query(
        `INSERT INTO user_absence_reminder_settings (user_id, enabled, threshold_days, reminder_hour, reminder_minute, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), threshold_days = VALUES(threshold_days), reminder_hour = VALUES(reminder_hour), reminder_minute = VALUES(reminder_minute), updated_at = NOW()`,
        [userId, enabled ? 1 : 0, thresholdDays, reminderHour, reminderMinute]
      );
    }

    res.json({
      success: true,
      settings: { enabled, thresholdDays, reminderHour, reminderMinute },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to save absence reminder settings.' });
  }
});

// ============================================
// MUSCLE GAIN TRACKER (per-user, server-synced)
// ============================================

app.get('/api/muscle-gain/records', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const [rows] = await pool.query<any>(
      'SELECT record_date, data FROM muscle_gain_records WHERE user_id = ? ORDER BY record_date ASC',
      [userId]
    );

    const records = (rows || []).map((r: any) => {
      const recordDate = r.record_date instanceof Date
        ? r.record_date.toISOString().slice(0, 10)
        : String(r.record_date || '').slice(0, 10);

      let data: any = r.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = {}; }
      }

      // Always return with a canonical `date` field.
      return { date: recordDate, ...(data || {}) };
    });

    res.json({ success: true, records });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to load muscle gain records.' });
  }
});

app.post('/api/muscle-gain/records', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { date, measurements, strengthStats, proteinIntake, notes } = req.body || {};

    if (!date || !measurements || !strengthStats || proteinIntake === undefined || proteinIntake === null) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const recordDate = String(date).slice(0, 10);
    const payload = {
      measurements,
      strengthStats,
      proteinIntake: Number(proteinIntake),
      notes: typeof notes === 'string' ? notes : '',
    };

    // Prefer PostgreSQL upsert.
    try {
      await pool.query(
        `INSERT INTO muscle_gain_records (user_id, record_date, data, created_at, updated_at)
         VALUES (?, ?, ?::jsonb, NOW(), NOW())
         ON CONFLICT (user_id, record_date)
         DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [userId, recordDate, JSON.stringify(payload)]
      );
    } catch (e: any) {
      // MySQL fallback.
      await pool.query(
        `INSERT INTO muscle_gain_records (user_id, record_date, data, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()`,
        [userId, recordDate, JSON.stringify(payload)]
      );
    }

    // Return the updated list for the chart.
    const [rows] = await pool.query<any>(
      'SELECT record_date, data FROM muscle_gain_records WHERE user_id = ? ORDER BY record_date ASC',
      [userId]
    );
    const records = (rows || []).map((r: any) => {
      const d = r.record_date instanceof Date ? r.record_date.toISOString().slice(0, 10) : String(r.record_date || '').slice(0, 10);
      let data: any = r.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = {}; }
      }
      return { date: d, ...(data || {}) };
    });

    res.json({ success: true, records });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to save muscle gain record.' });
  }
});

app.delete('/api/muscle-gain/records', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await pool.query('DELETE FROM muscle_gain_records WHERE user_id = ?', [userId]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to delete muscle gain records.' });
  }
});

// ============================================
// PROGRESS TRACKER (per-user, server-synced)
// ============================================

app.get('/api/progress/records', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const [rows] = await pool.query<any>(
      'SELECT id, record_date, data FROM progress_records WHERE user_id = ? ORDER BY record_date ASC, id ASC',
      [userId]
    );

    const records = (rows || []).map((r: any) => {
      const recordDate = r.record_date instanceof Date
        ? r.record_date.toISOString().slice(0, 10)
        : String(r.record_date || '').slice(0, 10);

      let data: any = r.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = {}; }
      }

      return { id: r.id, date: recordDate, ...(data || {}) };
    });

    res.json({ success: true, records });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to load progress records.' });
  }
});

app.post('/api/progress/records', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { date, weight, bmi, notes } = req.body || {};

    if (!date || weight === undefined || weight === null || bmi === undefined || bmi === null) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const recordDate = String(date).slice(0, 10);
    const payload = {
      weight: Number(weight),
      bmi: Number(bmi),
      notes: typeof notes === 'string' ? notes : '',
    };

    // Insert only (allow multiple entries per date if user wants).
    try {
      await pool.query(
        `INSERT INTO progress_records (user_id, record_date, data, created_at, updated_at)
         VALUES (?, ?, ?::jsonb, NOW(), NOW())`,
        [userId, recordDate, JSON.stringify(payload)]
      );
    } catch (e: any) {
      await pool.query(
        `INSERT INTO progress_records (user_id, record_date, data, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [userId, recordDate, JSON.stringify(payload)]
      );
    }

    const [rows] = await pool.query<any>(
      'SELECT id, record_date, data FROM progress_records WHERE user_id = ? ORDER BY record_date ASC, id ASC',
      [userId]
    );

    const records = (rows || []).map((r: any) => {
      const d = r.record_date instanceof Date ? r.record_date.toISOString().slice(0, 10) : String(r.record_date || '').slice(0, 10);
      let data: any = r.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = {}; }
      }
      return { id: r.id, date: d, ...(data || {}) };
    });

    res.json({ success: true, records });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to save progress record.' });
  }
});

app.delete('/api/progress/records', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await pool.query('DELETE FROM progress_records WHERE user_id = ?', [userId]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to delete progress records.' });
  }
});

app.delete('/api/progress/records/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid id.' });
    }

    await pool.query('DELETE FROM progress_records WHERE id = ? AND user_id = ?', [id, userId]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to delete progress record.' });
  }
});

// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Global error:', err.message);
  res.status(500).json({ 
    success: false, 
    message: 'Server error'
  });
});

process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled promise rejection:', reason);
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3002;

let dbConnected = false;


app.get('/api/ping', (req: Request, res: Response) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/version', (req: Request, res: Response) => {
  res.json({
    ok: true,
    service: process.env.RENDER_SERVICE_NAME || null,
    commit: process.env.RENDER_GIT_COMMIT || null,
    env: process.env.NODE_ENV || null,
    timestamp: new Date().toISOString(),
  });
});

// Test endpoints removed for production

// ===== SERVER INITIALIZATION =====

app.get('/', (req: Request, res: Response) => {
  res.send('Activecore Backend: running');
});

// QR Token Generation - register BEFORE 404 handler
app.use('/api/admin/qr-token', qrTokenRouter);

// Initialize database and start server - WILL BE CALLED AT THE END OF FILE
async function initialize() {
  try {
    // Create a timeout promise to prevent indefinite hanging
    const timeoutPromise = new Promise<boolean>((_, reject) => 
      setTimeout(() => reject(new Error('Database initialization timeout')), 30000)
    );
    
    const dbPromise = Promise.resolve(initializeDatabase());
    
    dbConnected = await Promise.race([dbPromise, timeoutPromise]);
  } catch (dbErr: any) {
    console.error('Database initialization error:', dbErr.message);
    dbConnected = false;
  }
  
  // Start server AFTER all routes are registered
  const portNum = Number(process.env.PORT || PORT || 3002);
  app.listen(portNum, () => {
    console.log(`\n✅ Server running on port ${portNum}`);
    try {
      // Start background scheduler (subscription expiry)
      const { startSubscriptionScheduler } = require('./scripts/subscriptionScheduler');
      if (startSubscriptionScheduler) startSubscriptionScheduler();
    } catch (err) {
      // Non-fatal: scheduler failed to start
      console.error('Failed to start subscription scheduler:', (err as any)?.message || err);
    }
  }).on('error', (err: any) => {
    console.error('Server error:', err);
    process.exit(1);
  });
}

// Ensure this runs after pool and env are ready
(async function ensureNotificationTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(64) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT NOW(),
        INDEX (user_id),
        INDEX (type)
      )
    `);
  } catch (err) {
  }
})();

(async function ensureEquipmentTableAtStartup() {
  try {
    await ensureEquipmentTable();
  } catch (err) {
  }
})();

(async function ensureMuscleGainTableAtStartup() {
  try {
    await ensureMuscleGainRecordsTable();
  } catch (err) {
  }
})();

(async function ensureProgressTableAtStartup() {
  try {
    await ensureProgressRecordsTable();
  } catch (err) {
  }
})();

(async function ensureAbsenceReminderSettingsTableAtStartup() {
  try {
    await ensureAbsenceReminderSettingsTable();
  } catch (err) {
  }
})();

// Setup email transporter
const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT) || 587;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const fromEmail = process.env.FROM_EMAIL || smtpUser;

// typed transporter so it isn't implicitly `any`
let transporter: Transporter | undefined;
let smtpReady = false;

if (smtpHost && smtpUser && smtpPass) {
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  transporter
    .verify()
    .then(() => {
      smtpReady = true;
    })
    .catch((err: any) => {
      smtpReady = false;
    });
} else {
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  // Prefer Brevo transactional API when API key is available
  if (process.env.BREVO_API_KEY && BrevoService && typeof BrevoService.sendEmail === 'function') {
    try {
      const sent = await BrevoService.sendEmail({
        to,
        subject,
        htmlContent: html,
        textContent: html,
      } as any);
      if (sent) return true;
      // fallthrough to SMTP if Brevo send failed
    } catch (err) {
      // continue to attempt SMTP as fallback
    }
  }

  if (!transporter) {
    return false;
  }
  try {
    const info = await transporter.sendMail({
      from: fromEmail,
      to,
      subject,
      html,
    });
    return true;
  } catch (err: any) {
    return false;
  }
}

/**
 * Validates password strength
 * Requirements: 8+ chars, 1 uppercase, 1 lowercase, 1 number, 1 special char
 */
function validatePassword(password: string): { isValid: boolean; message?: string } {
  if (!password || password.length < 8) {
    return { isValid: false, message: 'Password must be at least 8 characters' };
  }
  if (!/[A-Z]/.test(password)) {
    return { isValid: false, message: 'Password must contain at least one uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { isValid: false, message: 'Password must contain at least one lowercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { isValid: false, message: 'Password must contain at least one number' };
  }
  if (!/[!@#$%^&*]/.test(password)) {
    return { isValid: false, message: 'Password must contain at least one special character (!@#$%^&*)' };
  }
  return { isValid: true };
}

/**
 * Sanitizes string input to prevent injection attacks
 */
function sanitizeInput(input: any): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[<>\"']/g, '') // Remove HTML/script tags
    .trim()
    .substring(0, 255); // Max 255 chars
}

function normalizePHMobile(phone: any): string | null {
  const digits = String(phone || '').replace(/\D/g, '');

  if (/^09\d{9}$/.test(digits)) return digits;

  return null;
}

/**
 * Validates Philippine mobile numbers in local format.
 * Accepted input format: exactly 11 digits (09XXXXXXXXX).
 */
function isValidPhone(phone: string): boolean {
  return normalizePHMobile(phone) !== null;
}

/**
 * Validates monetary amount (0 < amount < 999999)
 */
function isValidAmount(amount: any): boolean {
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0 && num < 999999;
}

function isValidMembershipPlan(plan: any): plan is 'monthly' | 'quarterly' | 'annual' {
  const normalized = String(plan || '').trim().toLowerCase();
  return normalized === 'monthly' || normalized === 'quarterly' || normalized === 'annual';
}

function expectedAmountForPlan(plan: 'monthly' | 'quarterly' | 'annual'): number {
  if (plan === 'quarterly') return 200;
  if (plan === 'annual') return 300;
  return 100;
}

function isValidEmail(email?: string) {
  if (!email || typeof email !== 'string') return false;
  // simple regex — avoids outbound errors caused by malformed addresses
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function notifyInactiveMembers(thresholdDays = 3) {
  try {
    if (!transporter || !smtpReady) {
      return { success: false, message: 'SMTP not configured or credentials invalid' };
    }

    // Select members who haven't checked in within thresholdDays
    const [rows] = await pool.query<any>(
      `
      SELECT u.id, u.email, u.first_name, u.last_name, MAX(a.check_in_time) AS lastCheckIn
      FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id
      WHERE u.role = 'member' AND u.status = 'active'
      GROUP BY u.id
      HAVING (lastCheckIn IS NULL OR DATE(lastCheckIn) <= DATE_SUB(CURDATE(), INTERVAL ? DAY))
      `,
      [thresholdDays]
    );

    if (!rows || rows.length === 0) {
      return { success: true, notified: 0 };
    }

    let notifiedCount = 0;

    for (const u of rows) {
      if (!u.email || !isValidEmail(u.email)) {
        continue;
      }

      // Avoid resending within last thresholdDays
      const [alreadySent] = await pool.query<any>(
        `SELECT id FROM notification_logs WHERE user_id = ? AND type = 'absent_reminder' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1`,
        [u.id, thresholdDays]
      );

      if (alreadySent.length > 0) {
        continue;
      }

      const lastCheckInText = u.lastCheckIn ? `Your last visit was on ${new Date(u.lastCheckIn).toLocaleDateString()}.` : `We haven't seen you yet — start your journey with us!`;

      const subject = `We've missed you at ActiveCore — come back!`;
      const html = `
        <p>Hi ${u.first_name || 'Member'},</p>
        <p>${lastCheckInText}</p>
        <p>We noticed you haven't visited the gym in a while. Your fitness matters — we'd love to see you back! Here are a few ways to make it easier:</p>
        <ul>
          <li>Book a quick orientation with our trainer</li>
          <li>Try a refreshed workout plan</li>
          <li>Bring a friend and get motivated together</li>
        </ul>
        <p>If there's anything we can help with, just reply to this email.</p>
        <p>— ActiveCore</p>
      `;

      const sent = await sendEmail(u.email, subject, html);
      if (sent) {
        await pool.query(`INSERT INTO notification_logs (user_id, type, created_at) VALUES (?, 'absent_reminder', NOW())`, [u.id]);
        notifiedCount++;
      } else {
      }
    }

    return { success: true, notified: notifiedCount };
  } catch (err: any) {
    return { success: false, error: err.message || err };
  }
}

// Admin endpoint: trigger notifications manually
app.post('/api/admin/attendance/notify-inactive', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { thresholdDays = 3 } = req.body;
    const result = await notifyInactiveMembers(Number(thresholdDays));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to notify inactive members' });
  }
});

// Admin: Reactivate a user's account (manual override)
app.post('/api/admin/users/:id/reactivate', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const { markPaid } = req.body || {};

    await pool.query(
      `UPDATE users SET status = 'active', payment_status = ?, grace_until = NULL WHERE id = ?`,
      [markPaid ? 'paid' : 'pending', id]
    );

    res.json({ success: true, message: 'User reactivated' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to reactivate user', error: err.message });
  }
});

// Schedule daily run (once every 24h) at server start if desired
const NOTIFY_THRESHOLD_DAYS = Number(process.env.INACTIVE_NOTIFY_DAYS) || 3;
const DAILY_MS = 24 * 60 * 60 * 1000;
// Run once at startup
setTimeout(() => {
  notifyInactiveMembers(NOTIFY_THRESHOLD_DAYS).catch(() => {
    // Silently fail scheduled task � email service may not be configured
  });
}, 5 * 1000); // small delay on start
// Run every 24 hours
setInterval(() => {
  notifyInactiveMembers(NOTIFY_THRESHOLD_DAYS).catch(() => {
    // Silently fail scheduled task � email service may not be configured
  });
}, DAILY_MS);

// Admin endpoint: test sending email
app.post('/api/admin/attendance/test-email', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { to } = req.body;
    if (!to) {
      return res.status(400).json({ success: false, message: 'Missing "to" address in body' });
    }
    const subject = 'ActiveCore test email';
    const html = `<p>This is a test message from <strong>ActiveCore</strong>. If you received this, SMTP settings are valid.</p>`;
    const sent = await sendEmail(to, subject, html);
    if (!sent) {
      return res.status(500).json({ success: false, message: 'Failed to send test email. Check SMTP settings and logs.' });
    }
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to send test email.' });
  }
});

// Send absence reminders to all absent members
app.post('/api/admin/attendance/send-absence-reminders', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { thresholdDays } = req.body;
    const days = thresholdDays ? Math.max(1, Number(thresholdDays)) : 3;

    logInfo(`Admin triggered absence reminder campaign with ${days} day threshold`);
    const stats = await sendAbsenceReminders(days);

    res.json({
      success: true,
      message: `Absence reminder campaign completed`,
      stats: {
        totalAbsentUsers: stats.total,
        emailsSent: stats.sent,
        emailsFailed: stats.failed,
      },
    });
  } catch (error: any) {
    logError('Error in absence reminder endpoint:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send absence reminders',
      error: getErrorMessage(error),
    });
  }
});

// PayPal Test Endpoint
app.post('/api/test/paypal', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const tokenUrl = `${PAYPAL_API_URL.replace(/\/v2$/, '')}/v1/oauth2/token`;
    
    const axiosConfig = {
      auth: {
        username: PAYPAL_CLIENT_ID,
        password: PAYPAL_CLIENT_SECRET
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 5000
    };
    
    const response = await axios.post(tokenUrl, 'grant_type=client_credentials', axiosConfig);
    
    res.json({
      success: true,
      message: 'PayPal connection works!',
      tokenUrl,
      mode: PAYPAL_MODE,
      clientIdPrefix: PAYPAL_CLIENT_ID?.substring(0, 15) + '...'
    });
  } catch (error: any) {
    
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      status: error.response?.status,
      hint: 'Check that your PayPal credentials are correct'
    });
  }
});

// ==================== EQUIPMENT ROUTES (ADMIN) ====================

type EquipmentRow = {
  id: number;
  equip_name: string;
  category: string;
  purchase_date: any;
  status: string;
  last_maintenance: any;
  next_schedule: any;
  notes: string | null;
};

const toIsoDateOrEmpty = (input: any): string => {
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 10);
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  return String(input).slice(0, 10);
};

const mapEquipmentRow = (r: EquipmentRow) => ({
  id: r.id,
  equipName: r.equip_name,
  category: r.category,
  purchaseDate: toIsoDateOrEmpty(r.purchase_date),
  status: r.status,
  lastMaintenance: toIsoDateOrEmpty(r.last_maintenance),
  nextSchedule: toIsoDateOrEmpty(r.next_schedule),
  notes: r.notes || '',
});

app.get('/api/equipment', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const [rows] = await pool.query<EquipmentRow>(
      `SELECT id, equip_name, category, purchase_date, status, last_maintenance, next_schedule, notes
       FROM equipment
       ORDER BY equip_name ASC, id DESC`
    );
    res.json({ success: true, equipments: (rows || []).map(mapEquipmentRow) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to fetch equipment', error: getErrorMessage(err) });
  }
});

app.post('/api/equipment', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const {
      equipName,
      category,
      purchaseDate,
      status,
      lastMaintenance,
      nextSchedule,
      notes,
    } = req.body || {};

    if (!equipName || String(equipName).trim() === '') {
      return res.status(400).json({ success: false, message: 'Equipment name is required' });
    }
    if (!purchaseDate || String(purchaseDate).trim() === '') {
      return res.status(400).json({ success: false, message: 'Purchase date is required' });
    }

    const [rows] = await pool.query<any>(
      `INSERT INTO equipment (
        equip_name, category, purchase_date, status, last_maintenance, next_schedule, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      RETURNING id`,
      [
        String(equipName).trim(),
        String(category || 'cardio'),
        String(purchaseDate).slice(0, 10),
        String(status || 'operational'),
        lastMaintenance ? String(lastMaintenance).slice(0, 10) : null,
        nextSchedule ? String(nextSchedule).slice(0, 10) : null,
        notes ? String(notes) : null,
      ]
    );

    const newId = rows?.[0]?.id;
    res.status(201).json({ success: true, id: newId });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to add equipment', error: getErrorMessage(err) });
  }
});

app.put('/api/equipment/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid equipment id' });
    }

    const {
      equipName,
      category,
      purchaseDate,
      status,
      lastMaintenance,
      nextSchedule,
      notes,
    } = req.body || {};

    if (!equipName || String(equipName).trim() === '') {
      return res.status(400).json({ success: false, message: 'Equipment name is required' });
    }
    if (!purchaseDate || String(purchaseDate).trim() === '') {
      return res.status(400).json({ success: false, message: 'Purchase date is required' });
    }

    await pool.query(
      `UPDATE equipment
       SET equip_name = ?, category = ?, purchase_date = ?, status = ?, last_maintenance = ?, next_schedule = ?, notes = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        String(equipName).trim(),
        String(category || 'cardio'),
        String(purchaseDate).slice(0, 10),
        String(status || 'operational'),
        lastMaintenance ? String(lastMaintenance).slice(0, 10) : null,
        nextSchedule ? String(nextSchedule).slice(0, 10) : null,
        notes ? String(notes) : null,
        id,
      ]
    );

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to update equipment', error: getErrorMessage(err) });
  }
});

app.delete('/api/equipment/:id', authenticateToken, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid equipment id' });
    }
    await pool.query('DELETE FROM equipment WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to delete equipment', error: getErrorMessage(err) });
  }
});

// App configuration
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Helper function to get PayPal access token
async function getPayPalAccessToken(): Promise<string> {
  try {
    // PayPal OAuth token endpoint is under v1; keep v2 for other APIs
    const tokenUrl = `${PAYPAL_API_URL.replace(/\/v2$/, '')}/v1/oauth2/token`;
    
    debugLog('🔵 [PayPal Token] URL:', tokenUrl);
    debugLog('🔵 [PayPal Token] Mode:', PAYPAL_MODE);
    debugLog('🔵 [PayPal Token] Client ID prefix:', PAYPAL_CLIENT_ID?.substring(0, 10) + '...');
    debugLog('🔵 [PayPal Token] Secret length:', PAYPAL_CLIENT_SECRET?.length);
    
    // Use Base64 encoding for auth header instead of axios auth
    const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    debugLog('🔵 [PayPal Token] Credentials base64 length:', credentials.length);
    
    const response = await axios.post(
      tokenUrl,
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );
    
    const tokenData = response.data as any;
    debugLog('🟢 [PayPal Token] Success, token length:', tokenData.access_token?.length);
    return tokenData.access_token;
  } catch (error: any) {
    if (isProduction) {
      console.error('🔴 [PayPal Token] Failed:', {
        message: error.message,
        status: error.response?.status,
      });
    } else {
      console.error('🔴 [PayPal Token] Complete error:', {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        errorData: error.response?.data,
        url: error.config?.url,
        method: error.config?.method
      });
    }
    throw new Error('PayPal authentication failed: ' + (error.response?.data?.error_description || error.message));
  }
}

function normalizeMembershipPlan(raw: any): 'monthly' | 'quarterly' | 'annual' {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'quarterly') return 'quarterly';
  if (value === 'annual') return 'annual';
  return 'monthly';
}

function computeSubscriptionEndFromStart(start: Date, plan: 'monthly' | 'quarterly' | 'annual'): Date {
  const end = new Date(start);
  if (plan === 'annual') end.setFullYear(end.getFullYear() + 1);
  else if (plan === 'quarterly') end.setMonth(end.getMonth() + 3);
  else end.setMonth(end.getMonth() + 1);
  return end;
}

async function resolveSubscriptionWindow(
  userId: number,
  planInput: any
): Promise<{ subscriptionStart: Date; subscriptionEnd: Date }> {
  const plan = normalizeMembershipPlan(planInput);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let subscriptionStart = new Date(today);

  const [rows] = await pool.query<any>(
    `SELECT subscription_end FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );

  const currentEndRaw = Array.isArray(rows) && rows.length > 0 ? rows[0]?.subscription_end : null;
  if (currentEndRaw) {
    const currentEnd = new Date(currentEndRaw);
    if (!Number.isNaN(currentEnd.getTime())) {
      currentEnd.setHours(0, 0, 0, 0);
      if (currentEnd.getTime() > today.getTime()) {
        subscriptionStart = currentEnd;
      }
    }
  }

  const subscriptionEnd = computeSubscriptionEndFromStart(subscriptionStart, plan);
  return { subscriptionStart, subscriptionEnd };
}

async function applyPayPalSubscriptionActivation(params: {
  userId: number;
  orderId: string;
  captureId?: string;
  fallbackPlan?: string;
  fallbackAmount?: number;
}) {
  const { userId, orderId, captureId, fallbackPlan, fallbackAmount } = params;

  const [paymentRows] = await pool.query<any>(
    `SELECT amount, membership_type FROM payments WHERE transaction_id = ? AND user_id = ? LIMIT 1`,
    [orderId, userId]
  );

  const dbRow = Array.isArray(paymentRows) && paymentRows.length > 0 ? paymentRows[0] : null;
  const plan = normalizeMembershipPlan(fallbackPlan || dbRow?.membership_type);
  const paymentAmount = Number(dbRow?.amount) || Number(fallbackAmount) || 0;

  await pool.query(
    `UPDATE payments SET payment_status = ?, payment_date = NOW() WHERE transaction_id = ? AND user_id = ?`,
    ['paid', orderId, userId]
  );

  const { subscriptionStart, subscriptionEnd } = await resolveSubscriptionWindow(userId, plan);

  const hasNextPayment = await dbColumnExists('users', 'next_payment');
  const userUpdateFields = [
    `status = 'active'`,
    `payment_status = 'paid'`,
    `subscription_start = ?`,
    `subscription_end = ?`,
    `grace_until = NULL`,
    `membership_type = ?`,
    `membership_price = ?`,
  ];
  const userUpdateValues: any[] = [
    isoDateString(subscriptionStart),
    isoDateString(subscriptionEnd),
    plan,
    paymentAmount,
  ];

  if (hasNextPayment) {
    userUpdateFields.push(`next_payment = ?`);
    userUpdateValues.push(isoDateString(subscriptionEnd));
  }

  userUpdateValues.push(userId);

  await pool.query(
    `UPDATE users SET ${userUpdateFields.join(', ')} WHERE id = ?`,
    userUpdateValues
  );

  try {
    await pool.query(
      `INSERT INTO payments_history (user_id, payment_id, amount, payment_method, status, created_at)
         VALUES (?, ?, ?, 'paypal', 'completed', NOW())`,
      [userId, captureId || orderId, paymentAmount]
    );
  } catch (historyErr: any) {
    console.warn('PayPal capture: payments_history insert skipped:', getErrorMessage(historyErr));
  }

  return {
    plan,
    paymentAmount,
    subscriptionStart,
    subscriptionEnd,
  };
}

// Create a PayPal order and return redirect URL
app.post('/api/payments/paypal/create-order', paymentLimiter, authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { amount, plan } = req.body;

    debugLog('🔵 [PayPal] Create order request:', { userId, amount, plan, timestamp: new Date().toISOString() });

    // Validate input
    if (!amount || !plan) {
      return res.status(400).json({ success: false, message: 'Missing amount or plan' });
    }

    if (!isValidMembershipPlan(plan)) {
      return res.status(400).json({ success: false, message: 'Invalid membership plan' });
    }

    const normalizedPlan = String(plan).trim().toLowerCase() as 'monthly' | 'quarterly' | 'annual';
    const parsedAmount = Number(amount);
    const expectedAmount = expectedAmountForPlan(normalizedPlan);

    if (!isValidAmount(parsedAmount)) {
      return res.status(400).json({ success: false, message: 'Invalid payment amount' });
    }

    // Prevent client-side tampering by requiring the fixed amount for each plan.
    if (Math.abs(parsedAmount - expectedAmount) > 0.0001) {
      return res.status(400).json({ success: false, message: 'Amount does not match selected plan' });
    }

    debugLog('🔵 [PayPal] Getting access token...');
    const accessToken = await getPayPalAccessToken();
    debugLog('🟢 [PayPal] Access token obtained');

    const planDescription = normalizedPlan === 'monthly' ? 'Monthly Membership' : 
                           normalizedPlan === 'quarterly' ? 'Quarterly Membership' :
                           'Annual Membership';

    const payload = {
      intent: 'CAPTURE',
      payer: {
        email_address: `user_${userId}@activecore.test`
      },
      purchase_units: [{
        amount: {
          currency_code: 'PHP',
          value: parsedAmount.toFixed(2)
        },
        description: planDescription,
        custom_id: `${userId}|${normalizedPlan}` // Store userId and plan in custom_id
      }],
      application_context: {
        brand_name: 'ActiveCore Fitness',
        landing_page: 'BILLING',
        user_action: 'PAY_NOW',
        return_url: `${APP_URL}/member/payment/success`,
        cancel_url: `${APP_URL}/member/payment/failed`
      }
    };

    debugLog('🔵 [PayPal] Creating PayPal order with payload:', JSON.stringify(payload, null, 2));

    const response = await axios.post(`${PAYPAL_API_URL}/checkout/orders`, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 second timeout
    });

    const responseData = response.data as any;
    const orderId = responseData.id;
    const approvalLink = responseData.links?.find((link: any) => link.rel === 'approve')?.href;

    debugLog('🟢 [PayPal] Order created:', { orderId, approvalLink });

    if (!orderId || !approvalLink) {
      console.error('🔴 [PayPal] Missing orderId or approvalLink in response');
      return res.status(500).json({ success: false, message: 'Failed to create payment order' });
    }

    // Insert payment record (pending)
    debugLog('🔵 [PayPal] Inserting payment record...');
    await pool.query(
      `INSERT INTO payments (user_id, amount, payment_method, membership_type, payment_status, transaction_id, created_at)
         VALUES (?, ?, 'paypal', ?, 'pending', ?, NOW())`,
      [userId, parsedAmount, normalizedPlan, orderId]
    );
    debugLog('🟢 [PayPal] Payment record inserted');

    res.json({ success: true, approvalLink, orderId });
  } catch (err: any) {
    const isDevelopment = process.env.NODE_ENV === 'development';
    const errorCode = err.response?.status || 500;
    
    if (isProduction) {
      console.error('🔴 [PayPal] Error occurred:', {
        message: err.message,
        status: err.response?.status,
      });
    } else {
      console.error('🔴 [PayPal] Error occurred:', {
        message: err.message,
        status: err.response?.status,
        data: err.response?.data,
        isDevelopment
      });
    }
    
    // Safe error message for client
    const clientMessage = errorCode === 401 || errorCode === 403
      ? 'Payment service authentication failed. Please contact support.'
      : errorCode >= 400 && errorCode < 500
      ? 'Invalid payment request. Please check your details and try again.'
      : 'Payment service temporarily unavailable. Please try again later.';
    
    res.status(500).json({ 
      success: false, 
      message: clientMessage,
      ...(isDevelopment && { debug: { error: err.message, status: err.response?.status, data: err.response?.data } })
    });
  }
});

// Capture PayPal order and update subscription
app.post('/api/payments/paypal/capture-order', paymentLimiter, async (req: AuthRequest, res: Response) => {
  let resolvedUserId: number | null = null;
  let normalizedOrderId = '';
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Missing orderId' });
    }

    normalizedOrderId = String(orderId).trim();
    if (!/^[A-Z0-9]{10,30}$/i.test(normalizedOrderId)) {
      return res.status(400).json({ success: false, message: 'Invalid orderId format' });
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let tokenUserId: number | null = null;

    if (token) {
      try {
        const decoded = jwt.verify(token, getJwtSecret()) as any;
        const parsedUserId = Number(decoded?.id);
        tokenUserId = Number.isFinite(parsedUserId) ? parsedUserId : null;
      } catch {
        tokenUserId = null;
      }
    }

    const [orderRows] = await pool.query<any>(
      `SELECT user_id as userId FROM payments WHERE transaction_id = ? ORDER BY id DESC LIMIT 1`,
      [normalizedOrderId]
    );
    const orderUserIdRaw = Array.isArray(orderRows) && orderRows.length > 0 ? orderRows[0]?.userId : null;
    const orderUserId = Number.isFinite(Number(orderUserIdRaw)) ? Number(orderUserIdRaw) : null;

    if (tokenUserId && orderUserId && tokenUserId !== orderUserId) {
      return res.status(403).json({ success: false, message: 'Order does not belong to authenticated user' });
    }

    const userId = tokenUserId || orderUserId;
    if (!userId) {
      return res.status(404).json({ success: false, message: 'Payment order not found in local records' });
    }
    resolvedUserId = userId;

    const accessToken = await getPayPalAccessToken();

    // Capture the payment
    const captureResponse = await axios.post(
      `${PAYPAL_API_URL}/checkout/orders/${normalizedOrderId}/capture`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const captureData = captureResponse.data as any;
    const paymentStatus = captureData.status;
    const captureId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    const customId = captureData.purchase_units?.[0]?.custom_id;
    const customPlan = (customId?.split('|')?.[1] || '').toString().toLowerCase();
    const captureAmount = Number(captureData?.purchase_units?.[0]?.amount?.value) || undefined;

    if (paymentStatus !== 'COMPLETED') {
      return res.json({ success: false, status: paymentStatus, message: 'Payment not completed' });
    }

    const activation = await applyPayPalSubscriptionActivation({
      userId,
      orderId: normalizedOrderId,
      captureId,
      fallbackPlan: customPlan,
      fallbackAmount: captureAmount,
    });


    res.json({
      success: true,
      status: 'completed',
      subscription: {
        start: activation.subscriptionStart.toISOString().split('T')[0],
        end: activation.subscriptionEnd.toISOString().split('T')[0],
        type: activation.plan
      }
    });
  } catch (err: any) {
    // If PayPal says this order was already captured, reconcile local records anyway.
    if (err.response?.status === 422) {
      const details = err.response?.data?.details;
      const alreadyCaptured = Array.isArray(details)
        && details.some((d: any) => String(d?.issue || '').toUpperCase() === 'ORDER_ALREADY_CAPTURED');

      if (alreadyCaptured) {
        try {
          const [fallbackRows] = await pool.query<any>(
            `SELECT user_id as userId FROM payments WHERE transaction_id = ? ORDER BY id DESC LIMIT 1`,
            [normalizedOrderId]
          );
          const fallbackUserIdRaw = Array.isArray(fallbackRows) && fallbackRows.length > 0 ? fallbackRows[0]?.userId : null;
          const fallbackUserId = Number.isFinite(Number(fallbackUserIdRaw))
            ? Number(fallbackUserIdRaw)
            : resolvedUserId;
          if (!fallbackUserId) {
            return res.status(404).json({ success: false, message: 'Payment order not found in local records' });
          }
          const activation = await applyPayPalSubscriptionActivation({ userId: fallbackUserId, orderId: normalizedOrderId });
          return res.json({
            success: true,
            status: 'completed',
            reconciled: true,
            subscription: {
              start: activation.subscriptionStart.toISOString().split('T')[0],
              end: activation.subscriptionEnd.toISOString().split('T')[0],
              type: activation.plan,
            },
          });
        } catch (reconcileErr: any) {
          return res.status(500).json({ success: false, message: 'Payment captured but subscription reconciliation failed' });
        }
      }
    }

    
    // If it's a 404, order may not exist
    if (err.response?.status === 404) {
      return res.status(400).json({ success: false, message: 'PayPal order not found' });
    }

    res.status(500).json({ success: false, message: 'Failed to capture PayPal payment' });
  }
});

// 404 handler - must be registered AFTER all routes
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    path: req.path,
    method: req.method,
  });
});

// Start server AFTER all routes and middleware are registered
initialize();
