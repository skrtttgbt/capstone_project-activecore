import React, { useCallback, useEffect, useState } from "react";
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonFooter,
  IonCard,
  IonCardContent,
  IonButton,
  IonSelect,
  IonSelectOption,
  IonItem,
  IonLabel,
  IonInput,
  IonSpinner,
  IonIcon,
  IonModal,
  IonButtons,
  IonGrid,
  IonRow,
  IonCol,
  IonMenuButton,
  IonAlert,
  useIonToast,
  IonCardHeader,
  IonCardTitle,
  IonSegment,
  IonSegmentButton,
} from "@ionic/react";
import {
  restaurant,
  fitness,
  calendar,
  save,
  close,
  refresh,
  nutrition,
  eye,
  trash,
  documents,
  flame,
  cart,
  bulb,
  warning,
  checkmarkCircle,
  listCircle,
  time,
} from "ionicons/icons";
import "./MealPlanner.css";

import { API_CONFIG } from "../config/api.config";
import { ensureToken } from "../services/auth.service";

const API_URL = API_CONFIG.BASE_URL;

const COMMON_ALLERGIES: Array<{ value: string; label: string }> = [
  { value: 'dairy', label: 'Dairy (Milk, Cheese)' },
  { value: 'egg', label: 'Egg' },
  { value: 'fish', label: 'Fish' },
  { value: 'shellfish', label: 'Shellfish (Shrimp/Crab)' },
  { value: 'peanut', label: 'Peanuts' },
  { value: 'tree_nut', label: 'Tree Nuts (Cashew/Almond)' },
  { value: 'soy', label: 'Soy' },
  { value: 'wheat_gluten', label: 'Wheat / Gluten' },
  { value: 'sesame', label: 'Sesame' },
];

const PH_COMMON_DIETS: Array<{ value: string; label: string }> = [
  { value: '', label: '🍽️ No Specific Diet' },
  { value: 'high_protein', label: '💪 High Protein' },
  { value: 'low_carb', label: '🥗 Low Carb' },
  { value: 'low_fat', label: '🐔 Low Fat' },
  { value: 'low_sodium', label: '🧂 Low Sodium' },
  { value: 'vegetarian', label: '🥬 Vegetarian' },
];

const HEALTH_CONDITIONS: Array<{ value: string; label: string }> = [
  { value: 'hypertension', label: 'Hypertension' },
  { value: 'diabetes', label: 'Diabetes' },
  { value: 'obesity_overweight', label: 'Obesity / Overweight' },
  { value: 'dyslipidemia_cardiovascular', label: 'Dyslipidemia / Cardiovascular' },
  { value: 'chronic_kidney_disease', label: 'Chronic Kidney Disease' },

];

const CULTURAL_CONTEXTS: Array<{ value: string; label: string }> = [
  { value: 'filipino', label: 'Filipino' },
  { value: 'filipino_budget', label: 'Filipino budget/local foods' },
  { value: 'mixed_asian', label: 'Mixed Asian' },
  { value: 'western', label: 'Western-influenced' },
];

const RELIGIOUS_RESTRICTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'None' },
  { value: 'halal', label: 'Halal / no pork' },
  { value: 'no_pork', label: 'No pork' },
  { value: 'no_beef', label: 'No beef' },
  { value: 'vegetarian', label: 'Vegetarian' },
];

const FOOD_PREFERENCES: Array<{ value: string; label: string }> = [
  { value: 'home_cooked', label: 'Home-cooked' },
  { value: 'budget_friendly', label: 'Budget-friendly' },
  { value: 'high_fiber', label: 'High fiber' },
  { value: 'low_sodium', label: 'Low sodium' },
  { value: 'no_fried_foods', label: 'Avoid fried foods' },
  { value: 'vegetable_forward', label: 'Vegetable-forward' },
];

const SOCIOECONOMIC_LEVELS: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low budget' },
  { value: 'middle', label: 'Moderate budget' },
  { value: 'high', label: 'Flexible budget' },
];

const SMOKING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'none', label: 'Non-smoker' },
  { value: 'former', label: 'Former smoker' },
  { value: 'current', label: 'Current smoker' },
];

const ALCOHOL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'none', label: 'No alcohol' },
  { value: 'occasional', label: 'Occasional' },
  { value: 'frequent', label: 'Frequent' },
];

const normalizeDietValue = (raw: any): string => {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'none' || value === 'no_specific_diet') return '';

  const canonical = value.replace(/[\s-]+/g, '_');
  const allowed = new Set(PH_COMMON_DIETS.map((d) => d.value));
  return allowed.has(canonical) ? canonical : '';
};

const parseDelimitedSelection = (input: any): string[] => {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof input !== 'string') return [];
  return input
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
};

const normalizeToKnownValues = (raw: string[], known: Array<{ value: string; label: string }>): string[] => {
  const knownByValue = new Map(known.map((k) => [k.value.toLowerCase(), k.value]));
  const knownByLabel = new Map(known.map((k) => [k.label.toLowerCase(), k.value]));
  return raw
    .map((r) => String(r || '').trim())
    .filter(Boolean)
    .map((r) => {
      const low = r.toLowerCase();
      return knownByValue.get(low) || knownByLabel.get(low) || null;
    })
    .filter(Boolean) as string[];
};

// ============ MODERN UI COMPONENTS ============
// Summary Bar - persistent top summary
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SummaryBar: React.FC<{ calories: number; protein: number }> = ({ calories, protein }) => (
  <div className="mp-summary-bar">
    <div className="mp-summary-item">
      <span className="mp-icon">🔥</span>
      <div>
        <div className="mp-label">Calories</div>
        <div className="mp-value">{calories} kcal</div>
      </div>
    </div>
    <div className="mp-summary-item">
      <span className="mp-icon">💪</span>
      <div>
        <div className="mp-label">Protein</div>
        <div className="mp-value">{protein} g</div>
      </div>
    </div>
  </div>
);

// Day Selector - horizontal scrollable day tabs
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DaySelector: React.FC<{
  days: string[];
  value: string;
  onChange: (day: string) => void;
  scrollRef?: React.RefObject<HTMLDivElement>;
}> = ({ days, value, onChange }) => (
  <div className="mp-day-selector-wrapper">
    <IonSegment
      scrollable
      value={value}
      onIonChange={(e) => onChange(e.detail.value as string)}
      aria-label="Days"
    >
      {days.map((day) => (
        <IonSegmentButton key={day} value={day}>
          <IonLabel>{day.slice(0, 3)}</IonLabel>
        </IonSegmentButton>
      ))}
    </IonSegment>
  </div>
);

// Meal Accordion - expandable meal with colored stripe
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MealAccordion: React.FC<{
  meal: {
    id: string;
    title: string;
    calories?: number;
    protein?: number;
    carbs?: number;
    fats?: number;
    items?: string[];
  };
  color?: string;
  open?: boolean;
  onToggle?: () => void;
}> = ({ meal, color = "#8be04b", open = false, onToggle }) => {
  const [isOpen, setIsOpen] = React.useState(open);

  return (
    <div className={`mp-meal-accordion ${isOpen ? "open" : ""}`}>
      <div
        className="mp-meal-header"
        onClick={() => {
          setIsOpen(!isOpen);
          onToggle?.();
        }}
        style={{ borderLeftColor: color }}
      >
        <div className="mp-meal-icon" />
        <div className="mp-meta">
          <div className="mp-title">{meal.title}</div>
          <div className="mp-stats">
            <span>{meal.calories ?? "—"} kcal</span>
            <span>{meal.protein ?? "—"}g</span>
          </div>
        </div>
        <div className="mp-chev">{isOpen ? "▾" : "▸"}</div>
      </div>
      {isOpen && (
        <div className="mp-meal-body">
          {meal.items && <ul>{meal.items.map((it, i) => <li key={i}>{it}</li>)}</ul>}
        </div>
      )}
    </div>
  );
};

// ============ END MODERN UI COMPONENTS ============

interface Meal {
  name: string;
  ingredients: string[];
  portionSize: string;
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  recipe: string;
  // AI or server-provided instructions text (optional)
  instructions?: string;
  suitabilityNotes?: string[];
  citationIds?: string[];
}

interface DayMeals {
  breakfast: Meal;
  lunch: Meal;
  dinner: Meal;
  snack1: Meal;
  snack2: Meal;
}

interface DayPlan {
  day: string;
  meals: DayMeals;
  totalCalories: number;
  totalProtein: number;
  totalCarbs: number;
  totalFats: number;
}

interface MealPlan {
  weekPlan: DayPlan[];
  shoppingList: {
    proteins: string[];
    vegetables: string[];
    carbs: string[];
    others: string[];
    flat?: any[];
  };
  mealPrepTips: string[];
  nutritionTips: string[];
  evidenceSummary?: string[];
  citations?: NutritionCitation[];
  profileSummary?: any;
}

interface NutritionCitation {
  id: string;
  title: string;
  organization: string;
  url: string;
  summary?: string;
}

interface SavedMealPlan {
  id: number;
  plan_name: string;
  plan_data: MealPlan;
  generated_at: string;
  is_active: boolean;
}

const MealPlanner: React.FC = () => {
  // Form State
  const [lifestyle, setLifestyle] = useState<string>("moderate");
  const [mealType, setMealType] = useState<string>("balanced");
  const [goal, setGoal] = useState<string>("muscle_gain");
  const [diet, setDiet] = useState<string>(""); 
  const [allergies, setAllergies] = useState<string[]>([]);
  const [calorieTarget, setCalorieTarget] = useState<number>(2000);
  const [proteinTarget, setProteinTarget] = useState<number>(120);
  const [carbsTarget, setCarbsTarget] = useState<number>(250);
  const [fatsTarget, setFatsTarget] = useState<number>(65);
  const [age, setAge] = useState<number>(30);
  const [sex, setSex] = useState<string>("");
  const [heightCm, setHeightCm] = useState<number>(165);
  const [weightKg, setWeightKg] = useState<number>(65);
  const [healthConditions, setHealthConditions] = useState<string[]>([]);
  const [culturalContext, setCulturalContext] = useState<string>("filipino");
  const [religiousRestriction, setReligiousRestriction] = useState<string>("");
  const [foodPreferences, setFoodPreferences] = useState<string[]>(["home_cooked"]);
  const [socioeconomicStatus, setSocioeconomicStatus] = useState<string>("middle");
  const [dailyBudgetPhp, setDailyBudgetPhp] = useState<number>(250);
  const [smokingStatus, setSmokingStatus] = useState<string>("none");
  const [alcoholIntake, setAlcoholIntake] = useState<string>("none");

  // UI State
  const [loading, setLoading] = useState(false);
  const [mealPlan, setMealPlan] = useState<MealPlan | null>(null);
  const [showRecipeModal, setShowRecipeModal] = useState(false);
  const [selectedMeal, setSelectedMeal] = useState<any | null>(null);
  const [showPreferencesForm, setShowPreferencesForm] = useState(true);
  const [activeTab, setActiveTab] = useState<"week" | "today">("today");

  // Save/Edit features
  const [savedPlans, setSavedPlans] = useState<SavedMealPlan[]>([]);
  const [showSavedPlans, setShowSavedPlans] = useState<boolean>(false);
  const [currentPlanId, setCurrentPlanId] = useState<number | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [planName, setPlanName] = useState('');
  const [showDeleteAlert, setShowDeleteAlert] = useState<boolean>(false);
  const [planToDelete, setPlanToDelete] = useState<number | null>(null);
  const [showEditModal, setShowEditModal] = useState<boolean>(false);
  const [editingMeal, setEditingMeal] = useState<{
    dayIndex: number;
    mealType: keyof DayMeals;
  } | null>(null);

  // Redesigned UI State
  const [selectedDayName, setSelectedDayName] = useState<string>("Monday");
  const [selectedMealCategory, setSelectedMealCategory] = useState<"breakfast" | "lunch" | "dinner" | "snacks">("breakfast");
  const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const dayShorts = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const mealCategories: ("breakfast" | "lunch" | "dinner" | "snacks")[] = ["breakfast", "lunch", "dinner", "snacks"];
  const mealIcons: Record<string, string> = { breakfast: "🌅", lunch: "🌞", dinner: "🌙", snacks: "🍪" };
  
  const [presentToast] = useIonToast();

  const loadPreferences = useCallback(async () => {
    try {
      const token = (await ensureToken()) || localStorage.getItem("token") || "";
      if (!token) return;
      const response = await fetch(`${API_URL}/meal-planner/preferences`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        // Preferences are optional; avoid noisy console errors on first run.
        return;
      }

      const data = await response.json();
      if (data.success && data.hasPreferences) {
        const pref = data.preferences;
        const demographics = pref.demographics || {};
        const dietaryPrefs = pref.dietaryRestrictions || {};
        const socioeconomic = pref.socioeconomic || {};
        const lifestyleFactors = pref.lifestyleFactors || {};

        setLifestyle(pref.lifestyle || lifestyleFactors.physicalActivity || "moderate");
        setMealType(pref.mealType || "balanced");
        setGoal(pref.goal || "muscle_gain");
        setDiet(normalizeDietValue(pref.diet));
        setAge(Number(demographics.age) || 30);
        setSex(String(demographics.sex || ""));
        setHeightCm(Number(demographics.heightCm) || 165);
        setWeightKg(Number(demographics.weightKg) || 65);
        setHealthConditions(normalizeToKnownValues(parseDelimitedSelection(pref.healthConditions || []), HEALTH_CONDITIONS));
        setCulturalContext(String(dietaryPrefs.cultural || "filipino"));
        setReligiousRestriction(String(dietaryPrefs.religious || ""));
        setFoodPreferences(normalizeToKnownValues(parseDelimitedSelection(dietaryPrefs.foodPreferences || []), FOOD_PREFERENCES));
        setSocioeconomicStatus(String(socioeconomic.status || "middle"));
        setDailyBudgetPhp(Number(socioeconomic.dailyBudgetPhp) || 250);
        setSmokingStatus(String(lifestyleFactors.smokingStatus || "none"));
        setAlcoholIntake(String(lifestyleFactors.alcoholIntake || "none"));
        // Backward compatible: if older prefs stored a free-text restrictions field,
        // best-effort map it into our known allergy options.
        const prefAllergiesRaw = parseDelimitedSelection(pref.allergies || pref.dietaryRestrictions || '');
        setAllergies(normalizeToKnownValues(prefAllergiesRaw, COMMON_ALLERGIES));
        const prefCalories = Number(pref?.targets?.calories);
        if (Number.isFinite(prefCalories) && prefCalories > 0) {
          setCalorieTarget(prefCalories);
        }
        const prefProtein = Number(pref?.targets?.protein);
        const prefCarbs = Number(pref?.targets?.carbs);
        const prefFats = Number(pref?.targets?.fats);
        if (Number.isFinite(prefProtein) && prefProtein > 0) setProteinTarget(prefProtein);
        if (Number.isFinite(prefCarbs) && prefCarbs > 0) setCarbsTarget(prefCarbs);
        if (Number.isFinite(prefFats) && prefFats > 0) setFatsTarget(prefFats);
      }
    } catch (error) {
      console.error("Error loading preferences:", error);
    }
  }, []);

  async function checkBackendStatus(token?: string) {
    try {
      const resp = await fetch(`${API_URL}/system/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) {
        return { ok: false, status: resp.status, message: resp.statusText };
      }
      const data = await resp.json();
      return { ok: true, data };
    } catch (err: any) {
      return { ok: false, message: err?.message || String(err) };
    }
  }

  const boundedNumber = (value: number, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const buildMealPlannerPayload = () => ({
    lifestyle,
    mealType,
    goal,
    diet,
    allergies,
    healthConditions,
    demographics: {
      age: boundedNumber(age, 30, 10, 100),
      sex,
      heightCm: boundedNumber(heightCm, 165, 100, 240),
      weightKg: boundedNumber(weightKg, 65, 25, 250),
    },
    dietaryRestrictions: {
      cultural: culturalContext,
      religious: religiousRestriction,
      foodPreferences,
    },
    socioeconomic: {
      status: socioeconomicStatus,
      dailyBudgetPhp: boundedNumber(dailyBudgetPhp, 250, 50, 5000),
    },
    lifestyleFactors: {
      physicalActivity: lifestyle,
      smokingStatus,
      alcoholIntake,
    },
    targets: {
      calories: boundedNumber(calorieTarget, 2000, 800, 5000),
      protein: boundedNumber(proteinTarget, 120, 20, 350),
      carbs: boundedNumber(carbsTarget, 250, 20, 800),
      fats: boundedNumber(fatsTarget, 65, 10, 250),
    },
  });

  // Example handler: adjust to your variable names and state
  const generateMealPlan = async () => {
    setLoading(true);
    try {
      console.log('Starting mealplanner call: preparing request…');

      const token = (await ensureToken()) || '';
      if (!token) {
        presentToast({ message: '⚠️ Please log in before generating a meal plan.', duration: 2500, color: 'warning' });
        setLoading(false);
        return;
      }

      // Quick backend health check
      const status = await checkBackendStatus(token);
      if (!status.ok) {
        console.error('Backend health check failed:', status);
        presentToast({
          message: `⚠️ Backend unavailable: ${status.message ?? status.status}`,
          duration: 3500,
          color: 'danger'
        });
        setLoading(false);
        return;
      }

      const body = buildMealPlannerPayload();

      const resp = await fetch(`${API_URL}/meal-planner/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body)
      });

      console.log('HTTP status:', resp.status);

      // Try to decode JSON safely
      let json: any = null;
      try {
        json = await resp.json();
      } catch (parseErr: any) {
        console.error('Response parsing failed, non-JSON returned:', parseErr?.message || parseErr);
      }

      if (!resp.ok) {
        // Prefer server-sent message, fallback to status text
        const msg = json?.message || json?.error || resp.statusText || `Request failed (${resp.status})`;
        console.warn('Meal planner generate failed:', msg, json);
        presentToast({ message: msg, duration: 4000, color: 'danger' });
        setLoading(false);
        return;
      }

      if (!json || !json.mealPlan) {
        console.warn('Invalid response structure from server:', json);
        presentToast({
          message: 'Server returned an unexpected response. Check console/network.',
          duration: 4000,
          color: 'warning'
        });
        setLoading(false);
        return;
      }

      const normalized = ensurePlanNormalized(json.mealPlan); // changed to normalized plan
      setMealPlan(normalized);
      setShowPreferencesForm(false);
      setActiveTab('today');

      presentToast({
        message: '🍽️ Your 7-day Filipino meal plan is ready!',
        duration: 3000,
        color: 'success',
      });
      console.log('Meal plan generated successfully:', json.mealPlan);
    } catch (err: any) {
      console.error('Meal plan generation error:', err);
      presentToast({
        message: `❌ ${err?.message || 'Failed to generate meal plan. Check console/network.'}`,
        duration: 5000,
        color: 'danger',
      });
    } finally {
      setLoading(false);
    }
  };

  // Helper: categorize or normalize shopping list (server may return array or grouped object)
  const normalizeShoppingList = (raw: any) => {
    if (!raw) return { proteins: [], vegetables: [], carbs: [], others: [], flat: [] };

    // If server returns an array of {ingredient, estimate}
    if (Array.isArray(raw)) {
      const flat = raw.map((r) => ({ ingredient: r.ingredient ?? r.name ?? r, estimate: r.estimate ?? r.count ?? '1' }));
      return { proteins: [], vegetables: [], carbs: [], others: [], flat };
    }

    // If server returns grouped object
    return {
      proteins: raw.proteins || [],
      vegetables: raw.vegetables || [],
      carbs: raw.carbs || raw.carbs || [],
      others: raw.others || raw.others || [],
      flat: []
    };
  };

  const formatShoppingItemLabel = (item: any) => {
    const ingredient = String(item?.ingredient ?? item?.name ?? item ?? '').trim();
    const estimateRaw = item?.estimate ?? item?.count ?? '';
    const estimate = String(estimateRaw ?? '').trim();

    if (!ingredient) return 'Unknown ingredient';
    if (!estimate) return ingredient;
    return `${ingredient} — ${estimate}`;
  };

  // Update loadSavedPlans to handle rows with/without updatedAt
  const loadSavedPlans = useCallback(async () => {
    try {
      const token = (await ensureToken()) || localStorage.getItem("token") || "";
      if (!token) {
        setSavedPlans([]);
        return;
      }
      const response = await fetch(`${API_URL}/meal-planner/plans`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        setSavedPlans([]);
        return;
      }

      const data = await response.json();
      if (data.success) {
        setSavedPlans(
          data.plans.map((r: any) => ({
            id: r.id,
            plan_name: r.planName || r.plan_name,
            plan_data: r.plan_data || null,
            generated_at: r.generatedAt || r.generated_at || null,
            is_active: !!r.is_active
          }))
        );
      } else {
        // no plans or backend returned an error — show none
        setSavedPlans([]);
      }
    } catch (error) {
      console.error("Failed to load saved plans:", error);
      setSavedPlans([]);
    }
  }, []);

  useEffect(() => {
    loadPreferences();
    loadSavedPlans();
  }, [loadPreferences, loadSavedPlans]);

  // Load single saved plan by id (calls backend /plans/:id)
  const loadSavedPlanById = async (planId: number) => {
    try {
      const token = localStorage.getItem("token");
      const response = await fetch(`${API_URL}/meal-planner/plans/${planId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (data.success && data.plan && data.plan.data) {
        const normalizedPlan = ensurePlanNormalized(data.plan.data); // ensure normalized
        setMealPlan(normalizedPlan);
        setCurrentPlanId(planId);
        setShowSavedPlans(false);
        setShowPreferencesForm(false);
        setActiveTab("today");
        presentToast({ message: `📋 Loaded: ${data.plan.name}`, duration: 2000, color: "success" });
      } else {
        presentToast({ message: `Failed to load plan (${response.status})`, duration: 2500, color: "danger" });
      }
    } catch (err) {
      console.error("Failed to load saved plan:", err);
      presentToast({ message: "Failed to load saved plan", duration: 2000, color: "danger" });
    }
  };

  // Save meal plan - use backend expected fields (planName, mealPlan)
  const saveMealPlan = async () => {
    if (!mealPlan) return;

    try {
      const token = localStorage.getItem("token");
      const body = {
        planId: currentPlanId || undefined,
        planName: planName || `${goal} - ${mealType} Plan`,
        mealPlan
      };

      const response = await fetch(`${API_URL}/meal-planner/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (data.success) {
        setCurrentPlanId(data.planId || data.planId || null);
        setShowSaveModal(false);
        setPlanName("");
        await loadSavedPlans();
        presentToast({
          message: data.message || "✅ Meal plan saved successfully!",
          duration: 2000,
          color: "success",
        });
      } else {
        presentToast({ message: data.message || "Failed to save meal plan", duration: 2500, color: "danger" });
      }
    } catch (error) {
      console.error("Save failed:", error);
      presentToast({
        message: "❌ Failed to save meal plan",
        duration: 2000,
        color: "danger",
      });
    }
  };

  // Delete meal plan: call /meal-planner/plans/:id (backend path)
  const deleteMealPlan = async (planId: number) => {
    try {
      const token = localStorage.getItem("token");
      const response = await fetch(`${API_URL}/meal-planner/plans/${planId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await response.json();
      if (data.success) {
        await loadSavedPlans();
        if (currentPlanId === planId) {
          setCurrentPlanId(null);
          setMealPlan(null);
          setShowPreferencesForm(true);
        }
        presentToast({
          message: "🗑️ Meal plan deleted",
          duration: 2000,
          color: "success",
        });
      } else {
        presentToast({ message: data.message || "Failed to delete plan", duration: 2000, color: "danger" });
      }
    } catch (error) {
      presentToast({
        message: "❌ Failed to delete meal plan",
        duration: 2000,
        color: "danger",
      });
    }
  };

  const loadSavedPlan = (plan: SavedMealPlan) => {
    // Load via id to get full data
    loadSavedPlanById(plan.id);
  };

  // UI helper: show a short list of ingredients for preview
  const normalizeIngredientsToArray = (ings: any): string[] => {
    if (!ings) return [];
    if (Array.isArray(ings)) return ings as string[];

    if (typeof ings === "string") {
      // Try JSON parse first (some server responses store JSON array as string)
      try {
        const parsed = JSON.parse(ings);
        if (Array.isArray(parsed)) return parsed as string[];
      } catch { /* ignore parse error */ }

      // split by newlines, commas, semicolons
      return ings.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    }

    // If object with keys, try to stringify to array or use values
    if (typeof ings === "object") {
      try {
        const vals = Object.values(ings).flat();
        return vals.map(String).map(s => s.trim()).filter(Boolean);
      } catch { /* ignore */ }
    }

    return [];
  };

  const normalizePortionSize = (_portion: any): string => {
    return "1 serving";
  };

  // Update ingredientPreview to coerce inputs
  const ingredientPreview = (ingredients: any = [], max = 3) => {
    const arr = normalizeIngredientsToArray(ingredients);
    return arr.slice(0, max);
  };

  const getCitationLabel = (citationId: string) => {
    const source = mealPlan?.citations?.find((citation) => citation.id === citationId);
    return source?.organization || source?.title || citationId;
  };

  const getCitationById = (citationId: string) => {
    return mealPlan?.citations?.find((citation) => citation.id === citationId) || null;
  };

  const getTodayDayName = () => {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[new Date().getDay()];
  };

  const getDayMacroTotals = (dayPlan?: DayPlan | null) => {
    if (!dayPlan?.meals) {
      return { calories: 0, protein: 0, carbs: 0, fats: 0 };
    }

    const totals = Object.values(dayPlan.meals).reduce(
      (acc, meal: any) => {
        const protein = Number(meal?.protein ?? 0) || 0;
        const carbs = Number(meal?.carbs ?? 0) || 0;
        const fats = Number(meal?.fats ?? 0) || 0;

        acc.protein += protein;
        acc.carbs += carbs;
        acc.fats += fats;
        return acc;
      },
      { calories: 0, protein: 0, carbs: 0, fats: 0 }
    );

    totals.calories = calculateCaloriesFromMacros(totals.protein, totals.carbs, totals.fats, 0);
    return totals;
  };

  // Inline component: Compact Daily Meal Card
  const DailyMealCard = ({ meal, mealType, day }: { meal: any, mealType: string, day: string }) => {
    const mealObj = { ...(meal || {}), ingredients: normalizeIngredientsToArray((meal as any)?.ingredients) };
    const mealCalories = calculateMealCalories449(mealObj);
    return (
      <IonCard className="daily-meal-card">
        <IonCardContent>
          <h3 className="daily-meal-title">{mealObj.name}</h3>
          <div className="daily-meal-macros">
            <span>{mealCalories} cal</span>
            <span>{mealObj.protein ?? 0}g protein</span>
            <span>{mealObj.carbs ?? 0}g carbs</span>
            <span>{mealObj.fats ?? 0}g fats</span>
          </div>
          {Array.isArray(mealObj.ingredients) && mealObj.ingredients.length > 0 && (
            <p className="daily-meal-ingredients">
              <strong>Ingredients:</strong> {ingredientPreview(mealObj.ingredients).join(", ")}
            </p>
          )}
          <p className="daily-meal-portion"><strong>Portion:</strong> {normalizePortionSize(mealObj.portionSize)}</p>
          {Array.isArray(mealObj.suitabilityNotes) && mealObj.suitabilityNotes.length > 0 && (
            <div className="meal-evidence-preview">
              {mealObj.suitabilityNotes.slice(0, 2).map((note: string, idx: number) => (
                <span key={idx}>{note}</span>
              ))}
            </div>
          )}
          {Array.isArray(mealObj.citationIds) && mealObj.citationIds.length > 0 && (
            <p className="meal-source-preview">
              Sources: {mealObj.citationIds.slice(0, 3).map(getCitationLabel).join(", ")}
            </p>
          )}
          <div className="daily-meal-actions">
            <IonButton size="small" fill="outline" onClick={() => {
              if (mealPlan) {
                const dayIndex = mealPlan.weekPlan.findIndex(d => d.day === day);
                setEditingMeal({ dayIndex, mealType: mealType as keyof DayMeals });
                setShowEditModal(true);
              }
            }}>
              <IonIcon icon={refresh} slot="start" />
              Regenerate
            </IonButton>
            <IonButton size="small" fill="clear" onClick={() => {
              setSelectedMeal({ day, mealType, meal: mealObj });
              setShowRecipeModal(true);
            }}>
              <IonIcon icon={eye} slot="start" />
              Recipe
            </IonButton>
          </div>
        </IonCardContent>
      </IonCard>
    );
  };

  const todayPlan = mealPlan?.weekPlan?.find(d => d.day === selectedDayName) || mealPlan?.weekPlan?.find(d => d.day === getTodayDayName());
  const todayPlanTotals = getDayMacroTotals(todayPlan);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const MacroProgress = ({ label, value, target, icon }: { label: string; value: number; target: number; icon: string }) => {
    const percentage = Math.min((value / target) * 100, 100);
    return (
      <div className="macro-item">
        <div className="macro-header">
          <span className="macro-icon">{icon}</span>
          <span className="macro-label">{label}</span>
        </div>
        <div className="macro-progress-bar">
          <div className="macro-progress-fill" style={{ width: `${percentage}%` }}></div>
        </div>
        <div className="macro-values">
          <span className="macro-value">{value}g</span>
          <span className="macro-target">{target}g</span>
        </div>
      </div>
    );
  };

  // Helper: derive concise instruction text from recipe when explicit instructions missing
  function generateInstructionFromRecipe(recipe?: string | null): string {
    if (!recipe) return '';
    const s = String(recipe || '').trim();
    const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines.slice(0, 4).join(' ');
    const sentences = s.split(/(?<=[.!?])\s+/).map(p => p.trim()).filter(Boolean);
    if (sentences.length > 0) return sentences.slice(0, 3).join(' ');
    return s.substring(0, 200);
  }

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

  function calculateMealCalories449(meal: any): number {
    const protein = Number(meal?.protein ?? 0) || 0;
    const carbs = Number(meal?.carbs ?? 0) || 0;
    const fats = Number(meal?.fats ?? 0) || 0;
    return calculateCaloriesFromMacros(protein, carbs, fats, Number(meal?.calories ?? 0) || 0);
  }

  // Normalize single meal values (ensures numeric macros, default portion size, converts string ingredients)
  function normalizeMeal(m: any): Meal {
    if (!m || typeof m !== 'object') {
      return {
        name: String(m || '') || 'Unknown dish',
        ingredients: [],
        portionSize: '1 serving',
        calories: 0,
        protein: 0,
        carbs: 0,
        fats: 0,
        recipe: '',
        instructions: '',
        suitabilityNotes: [],
        citationIds: [],
      } as Meal;
    }
    const protein = Number(m.protein || m.prot || 0) || 0;
    const carbs = Number(m.carbs || m.carbohydrates || 0) || 0;
    const fats = Number(m.fats || m.fat || 0) || 0;
    return {
      name: String(m.name || m.title || 'Unknown dish'),
      ingredients: normalizeIngredientsToArray(m.ingredients || m.ings || []),
      portionSize: normalizePortionSize(m.portionSize || m.servings || '1 serving'),
      calories: calculateCaloriesFromMacros(protein, carbs, fats, Number(m.calories || m.cal || 0) || 0),
      protein,
      carbs,
      fats,
      recipe: String(m.recipe || m.instructions || ''),
      instructions: String(m.instructions || m.ai_instructions || m.recipe || ''),
      suitabilityNotes: Array.isArray(m.suitabilityNotes)
        ? m.suitabilityNotes.map(String).filter(Boolean)
        : Array.isArray(m.suitability_notes)
          ? m.suitability_notes.map(String).filter(Boolean)
          : [],
      citationIds: Array.isArray(m.citationIds)
        ? m.citationIds.map(String).filter(Boolean)
        : Array.isArray(m.citation_ids)
          ? m.citation_ids.map(String).filter(Boolean)
          : [],
    } as Meal;
  }

  // Add helper to recompute day totals
  function recomputeDayTotals(dayPlan: DayPlan): DayPlan {
    const newTotals = Object.values(dayPlan.meals).reduce(
      (acc, m) => {
        const protein = Number(m.protein || 0);
        const carbs = Number(m.carbs || 0);
        const fats = Number(m.fats || 0);
        acc.protein += protein;
        acc.carbs += carbs;
        acc.fats += fats;
        return acc;
      },
      { calories: 0, protein: 0, carbs: 0, fats: 0 }
    );
    newTotals.calories = calculateCaloriesFromMacros(newTotals.protein, newTotals.carbs, newTotals.fats, 0);
    return {
      ...dayPlan,
      totalCalories: newTotals.calories,
      totalProtein: newTotals.protein,
      totalCarbs: newTotals.carbs,
      totalFats: newTotals.fats,
    };
  }

  // Ensure plan is normalized (convert numbers, set instructions, recompute day totals)
  function ensurePlanNormalized(plan: any): MealPlan | null {
    if (!plan) return null;
    const weekArr = Array.isArray(plan.weekPlan) ? plan.weekPlan : (Array.isArray(plan) ? plan : []);
    const normalizedWeek = (weekArr as any[]).map((day: any) => {
      const mealsObj = { ...(day.meals || {}) };
      const mealKeys: (keyof DayMeals)[] = ['breakfast', 'lunch', 'dinner', 'snack1', 'snack2'];
      const newMeals: any = {};
      mealKeys.forEach((key) => {
        const raw = mealsObj[key] || {};
        const meal = normalizeMeal(raw);
        if (!meal.instructions || meal.instructions.trim() === '') {
          meal.instructions = generateInstructionFromRecipe(meal.recipe);
        }
        newMeals[key] = meal;
      });

      const updatedDay: DayPlan = {
        day: String(day.day || day.name || 'Day'),
        meals: newMeals,
        totalCalories: 0,
        totalProtein: 0,
        totalCarbs: 0,
        totalFats: 0,
      } as DayPlan;

      return recomputeDayTotals(updatedDay);
    });

    // Normalize shopping list if necessary (backend variants supported)
    const rawShoppingList =
      plan.shoppingList ?? plan.shopping_list ?? plan.shoppingItems ?? plan.shopping_items ?? null;
    const shoppingList = normalizeShoppingList(rawShoppingList);

    const rawMealPrepTips = plan.mealPrepTips ?? plan.meal_prep_tips ?? plan.prepTips ?? null;
    const mealPrepTips = Array.isArray(rawMealPrepTips)
      ? rawMealPrepTips
      : typeof rawMealPrepTips === 'string'
        ? rawMealPrepTips
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    const rawNutritionTips = plan.nutritionTips ?? plan.nutrition_tips ?? null;
    const nutritionTips = Array.isArray(rawNutritionTips)
      ? rawNutritionTips
      : typeof rawNutritionTips === 'string'
        ? rawNutritionTips
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    const rawEvidenceSummary = plan.evidenceSummary ?? plan.evidence_summary ?? [];
    const evidenceSummary = Array.isArray(rawEvidenceSummary)
      ? rawEvidenceSummary.map(String).filter(Boolean)
      : typeof rawEvidenceSummary === 'string'
        ? rawEvidenceSummary.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : [];

    const rawCitations = plan.citations ?? plan.sources ?? [];
    const citations = Array.isArray(rawCitations)
      ? rawCitations
          .map((source: any) => ({
            id: String(source?.id || '').trim(),
            title: String(source?.title || '').trim(),
            organization: String(source?.organization || '').trim(),
            url: String(source?.url || '').trim(),
            summary: source?.summary ? String(source.summary) : undefined,
          }))
          .filter((source: NutritionCitation) => source.id && source.title && source.url)
      : [];

    return {
      ...plan,
      weekPlan: normalizedWeek,
      shoppingList,
      mealPrepTips,
      nutritionTips,
      evidenceSummary,
      citations,
      profileSummary: plan.profileSummary ?? plan.profile_summary ?? null,
    } as MealPlan;
  }

  // Compute plan averages (returns rounded values)
  function computePlanAverages(plan: MealPlan | null) {
    if (!plan || !Array.isArray(plan.weekPlan) || plan.weekPlan.length === 0) return { avgCalories: 0, avgProtein: 0 };
    const total = plan.weekPlan.reduce(
      (acc, d) => {
        acc.calories += Number(d.totalCalories || 0);
        acc.protein += Number(d.totalProtein || 0);
        return acc;
      },
      { calories: 0, protein: 0 }
    );
    const count = plan.weekPlan.length || 1;
    return { avgCalories: Math.round(total.calories / count), avgProtein: Math.round(total.protein / count) };
  }

  // Prefer explicit AI instructions when available; fallback to recipe
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function getInstructionText(meal?: Meal | null): string | null {
    if (!meal) return null;
    if (meal.instructions && String(meal.instructions).trim()) return String(meal.instructions).trim();
    if (meal.recipe && String(meal.recipe).trim()) return String(meal.recipe).trim();
    return null;
  }

  // compute plan stats for display
  const planStats = computePlanAverages(mealPlan);

  // Helper: safely return normalized ingredients for a selected meal
  function getRecipeIngredients(sel: any): string[] {
    if (!sel) return [];
    const raw = sel?.meal?.ingredients ?? sel?.ingredients ?? [];
    return normalizeIngredientsToArray(raw);
  }
  // Use the existing selectedMeal state (do NOT redeclare it)
  const recipeIngredients = getRecipeIngredients(selectedMeal);

  // small helper - reuse existing normalizeMeal & recomputeDayTotals helpers in this file
  async function regenerateMeal(dayIndex: number, mealKey: keyof DayMeals) {
    if (!mealPlan) return;
    setLoading(true);
    try {
      const token = localStorage.getItem("token") || "";

      // API endpoint (configured via API_CONFIG.BASE_URL)
      const endpoint = `${API_URL}/meal-planner/regenerate`;

      // Current meal to exclude (avoid returning same meal)
      const currentMeal = mealPlan.weekPlan?.[dayIndex]?.meals?.[mealKey];
      const excludeNames = currentMeal?.name ? [String(currentMeal.name).trim()] : [];

      // Payload base - include current preferences for AI context
      const baseBody = {
        ...buildMealPlannerPayload(),
        dayIndex,
        mealType: mealKey,
        mealPlan: mealPlan.weekPlan ?? mealPlan,
        planId: currentPlanId ?? null,
        preference: mealType,
      };

      let json: any = null;
      let attempt = 0;
      const maxAttempts = 3;
      let lastReturnedName: string | null = null;

      while (attempt < maxAttempts) {
        attempt += 1;
        const body = { ...baseBody, excludeMealNames: excludeNames.concat(lastReturnedName ? [lastReturnedName] : []) };
        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
          });

          const txt = await resp.text().catch(() => "");
          try {
            json = txt ? JSON.parse(txt) : null;
          } catch {
            json = null;
          }

          if (!resp.ok) {
            // For 404 or HTML responses show helpful message and stop trying
            if (resp.status === 404 || (txt && txt.includes("<pre>Cannot POST"))) {
              presentToast({ message: `Server route not found: ${endpoint}`, duration: 3500, color: "danger" });
              console.error("Regenerate route not found. Response:", txt);
              return;
            }
            // For non-ok, try again if attempts left
            presentToast({ message: `Regenerate attempt ${attempt} failed (status ${resp.status}). Trying again...`, duration: 1800, color: "warning" });
            continue;
          }

          if (!json || !json.success) {
            // Server responded but not success - show message and break (or continue to try)
            const msg = json?.message || `Attempt ${attempt} failed - no success`;
            presentToast({ message: msg, duration: 3000, color: "warning" });
            // If server explicitly returned no-new-meal, break early
            if (json?.message?.toLowerCase()?.includes("already the same")) break;
            // otherwise try again
            continue;
          }

          // We got a successful response with a meal (handle multiple shapes)
          const rawNewMeal = json.newMeal ?? json.meal ?? json.generatedMeal ?? null;
          const newMealName = rawNewMeal?.name ? String(rawNewMeal.name).trim() : null;

          // If returned meal name is equal to one we're excluding, try again (on next attempt)
          if (newMealName && excludeNames.some(n => n.toLowerCase() === newMealName!.toLowerCase())) {
            lastReturnedName = newMealName;
            console.warn(`Regenerate attempt ${attempt} returned excluded meal "${newMealName}", re-trying...`);
            presentToast({ message: `Got same meal—retrying to find a different one...`, duration: 1200, color: "warning" });
            // small delay before retry
            await new Promise(r => setTimeout(r, 600));
            continue; // try again
          }

          // success and not excluded -> use it
          if (!rawNewMeal || !newMealName) {
            presentToast({ message: "Regenerate returned invalid meal", duration: 2500, color: "warning" });
            return;
          }

          const normalizedNewMeal = normalizeMeal(rawNewMeal);
          if (!normalizedNewMeal.instructions || normalizedNewMeal.instructions.trim() === "") {
            normalizedNewMeal.instructions = generateInstructionFromRecipe(normalizedNewMeal.recipe);
          }

          const nextShoppingList = json?.shoppingList ? normalizeShoppingList(json.shoppingList) : null;
          const nextPlanId = json?.planId ?? null;

          setMealPlan(prev => {
            if (!prev) return prev;
            const next = { ...prev };
            next.weekPlan = next.weekPlan.map((d, idx) => {
              if (idx !== dayIndex) return d;
              const updatedMeals = { ...d.meals, [mealKey]: normalizedNewMeal };
              return recomputeDayTotals({ ...d, meals: updatedMeals });
            });
            if (nextShoppingList) next.shoppingList = nextShoppingList;
            return next;
          });

          if (nextPlanId) setCurrentPlanId(nextPlanId);

          presentToast({ message: "🎉 Meal regenerated successfully", duration: 1600, color: "success" });
          setShowEditModal(false);
          setEditingMeal(null);
          return;
        } catch (err) {
          console.warn("Regenerate attempt error:", err);
          if (attempt < maxAttempts) {
            presentToast({ message: "Unexpected error — retrying...", duration: 1400, color: "warning" });
            await new Promise(r => setTimeout(r, 600));
            continue;
          } else {
            presentToast({ message: "Failed to regenerate meal — check the server logs", duration: 3000, color: "danger" });
            console.error("Final regenerate error:", err);
            return;
          }
        }
      }

      // Reached max attempts without success
      presentToast({ message: "Could not find a different meal after several tries.", duration: 3500, color: "warning" });
    } catch (err: any) {
      console.error("regenerateMeal error:", err);
      presentToast({
        message: "Error regenerating meal. Check console.",
        duration: 3000,
        color: "danger",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <IonPage>
      <IonHeader className="meal-planner-header">
        <IonToolbar className="meal-toolbar">
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>

          <IonTitle>
            <IonIcon icon={restaurant} className="header-icon" />
            Filipino Meal Planner
          </IonTitle>

          {/* Always show Save Plan button in header (visible when a plan exists) */}
          <IonButtons slot="end">
            <IonButton
              color="primary"
              onClick={() => setShowSaveModal(true)}
              disabled={!mealPlan} // only enabled when a plan is present
              className="save-plan-btn"
              >
              <IonIcon icon={save} slot="start" />
              {currentPlanId ? 'Update Plan' : 'Save Plan'}
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>

      <IonContent className="meal-planner-content">
        {/* Header Banner */}
        {!mealPlan && (
          <div className="meal-planner-hero">
            <div className="hero-content">
              <div className="hero-icon">🍽️</div>
              <h1>Filipino Meal Planner</h1>
              <p>AI-Powered Personalized Nutrition Plans</p>
            </div>
          </div>
        )}

        {/* Preferences Form */}
        {showPreferencesForm && !mealPlan && (
          <div className="preferences-section">
            <IonCard className="config-card">
              <IonCardContent>
                <h2 className="section-title">
                  <IonIcon icon={nutrition} /> Nutrition Profile
                </h2>

                <div className="form-subsection">
                  <h3>Demographic Profile</h3>
                  <IonGrid className="targets-grid">
                    <IonRow>
                      <IonCol size="6" sizeMd="3">
                        <IonItem className="custom-item">
                          <IonLabel position="stacked">Age</IonLabel>
                          <IonInput
                            type="number"
                            value={age}
                            onIonInput={(e) => setAge(Number(e.detail.value) || 30)}
                            className="custom-input"
                          />
                        </IonItem>
                      </IonCol>
                      <IonCol size="6" sizeMd="3">
                        <IonItem className="custom-item">
                          <IonLabel position="stacked">Sex</IonLabel>
                          <IonSelect value={sex} onIonChange={(e) => setSex(e.detail.value || "")}>
                            <IonSelectOption value="">Prefer not to say</IonSelectOption>
                            <IonSelectOption value="female">Female</IonSelectOption>
                            <IonSelectOption value="male">Male</IonSelectOption>
                          </IonSelect>
                        </IonItem>
                      </IonCol>
                      <IonCol size="6" sizeMd="3">
                        <IonItem className="custom-item">
                          <IonLabel position="stacked">Height (cm)</IonLabel>
                          <IonInput
                            type="number"
                            value={heightCm}
                            onIonInput={(e) => setHeightCm(Number(e.detail.value) || 165)}
                            className="custom-input"
                          />
                        </IonItem>
                      </IonCol>
                      <IonCol size="6" sizeMd="3">
                        <IonItem className="custom-item">
                          <IonLabel position="stacked">Weight (kg)</IonLabel>
                          <IonInput
                            type="number"
                            value={weightKg}
                            onIonInput={(e) => setWeightKg(Number(e.detail.value) || 65)}
                            className="custom-input"
                          />
                        </IonItem>
                      </IonCol>
                    </IonRow>
                  </IonGrid>
                </div>
                
                <div className="form-group">
                  <IonItem className="custom-item">
                    <IonLabel position="stacked">
                      <IonIcon icon={fitness} /> Lifestyle
                    </IonLabel>
                    <IonSelect value={lifestyle} onIonChange={(e) => setLifestyle(e.detail.value!)}>
                      <IonSelectOption value="sedentary">🛋️ Sedentary (Little/No Exercise)</IonSelectOption>
                      <IonSelectOption value="moderate">🚶 Moderate (Exercise 3-5x/week)</IonSelectOption>
                      <IonSelectOption value="active">🏃 Active (Exercise 6-7x/week)</IonSelectOption>
                    </IonSelect>
                  </IonItem>
                </div>

                <div className="form-group">
                  <IonItem className="custom-item">
                    <IonLabel position="stacked">
                      <IonIcon icon={restaurant} /> Meal Preference
                    </IonLabel>
                    <IonSelect value={mealType} onIonChange={(e) => setMealType(e.detail.value!)}>
                      <IonSelectOption value="balanced">⚖️ Balanced (Carbs, Protein, Fats)</IonSelectOption>
                      <IonSelectOption value="high_protein">💪 High Protein (Muscle Building)</IonSelectOption>
                      <IonSelectOption value="low_carb">🥗 Low Carb (Fat Loss)</IonSelectOption>
                    </IonSelect>
                  </IonItem>
                </div>

                <div className="form-group">
                  <IonItem className="custom-item">
                    <IonLabel position="stacked">
                      <IonIcon icon={flame} /> Fitness Goal
                    </IonLabel>
                    <IonSelect value={goal} onIonChange={(e) => setGoal(e.detail.value!)}>
                      <IonSelectOption value="muscle_gain">💪 Muscle Gain</IonSelectOption>
                      <IonSelectOption value="weight_loss">🔥 Weight Loss</IonSelectOption>
                      <IonSelectOption value="maintain">⚖️ Maintenance</IonSelectOption>
                    </IonSelect>
                  </IonItem>
                </div>

                <div className="form-subsection">
                  <h3>Health Conditions</h3>
                  <IonItem className="custom-item" lines="none">
                    <IonLabel position="stacked">
                      <IonIcon icon={warning} /> Conditions
                    </IonLabel>
                    <IonSelect
                      multiple
                      value={healthConditions}
                      placeholder="Select health conditions"
                      onIonChange={(e) => setHealthConditions((e.detail.value as string[]) || [])}
                    >
                      {HEALTH_CONDITIONS.map((opt) => (
                        <IonSelectOption key={opt.value} value={opt.value}>
                          {opt.label}
                        </IonSelectOption>
                      ))}
                    </IonSelect>
                  </IonItem>
                  {healthConditions.length > 0 && (
                    <div className="restriction-chip">
                      <IonIcon icon={checkmarkCircle} />
                      <IonLabel>{healthConditions.length} condition filter{healthConditions.length === 1 ? '' : 's'} applied</IonLabel>
                    </div>
                  )}
                </div>

                <div className="form-subsection">
                  <h3>Dietary Restrictions</h3>

                <div className="form-group">
                  <IonItem className="custom-item">
                    <IonLabel position="stacked">
                      <IonIcon icon={restaurant} /> Diet Type (Optional)
                    </IonLabel>
                    <IonSelect value={diet} onIonChange={(e) => setDiet(e.detail.value!)}>
                      {PH_COMMON_DIETS.map((opt) => (
                        <IonSelectOption key={opt.value || 'none'} value={opt.value}>
                          {opt.label}
                        </IonSelectOption>
                      ))}
                    </IonSelect>
                  </IonItem>
                </div>

                <div className="form-group">
                  <IonItem className="custom-item">
                    <IonLabel position="stacked">Cultural Context</IonLabel>
                    <IonSelect value={culturalContext} onIonChange={(e) => setCulturalContext(e.detail.value || "filipino")}>
                      {CULTURAL_CONTEXTS.map((opt) => (
                        <IonSelectOption key={opt.value} value={opt.value}>
                          {opt.label}
                        </IonSelectOption>
                      ))}
                    </IonSelect>
                  </IonItem>
                </div>

                <div className="form-group">
                  <IonItem className="custom-item">
                    <IonLabel position="stacked">Religious Restriction</IonLabel>
                    <IonSelect value={religiousRestriction} onIonChange={(e) => setReligiousRestriction(e.detail.value || "")}>
                      {RELIGIOUS_RESTRICTIONS.map((opt) => (
                        <IonSelectOption key={opt.value || 'none'} value={opt.value}>
                          {opt.label}
                        </IonSelectOption>
                      ))}
                    </IonSelect>
                  </IonItem>
                </div>

                <div className="form-group">
                  <IonItem className="custom-item">
                    <IonLabel position="stacked">Food Preferences</IonLabel>
                    <IonSelect
                      multiple
                      value={foodPreferences}
                      placeholder="Select preferences"
                      onIonChange={(e) => setFoodPreferences((e.detail.value as string[]) || [])}
                    >
                      {FOOD_PREFERENCES.map((opt) => (
                        <IonSelectOption key={opt.value} value={opt.value}>
                          {opt.label}
                        </IonSelectOption>
                      ))}
                    </IonSelect>
                  </IonItem>
                </div>

                {/* Allergies/Restrictions Section */}
                <div className="form-group">
                  <IonItem className="custom-item" lines="none">
                    <IonLabel position="stacked">
                      <IonIcon icon={warning} style={{ color: "#ff9800" }} /> Allergies
                    </IonLabel>
                    <IonSelect
                      multiple
                      value={allergies}
                      placeholder="Select allergies (optional)"
                      onIonChange={(e) => setAllergies((e.detail.value as string[]) || [])}
                    >
                      {COMMON_ALLERGIES.map((opt) => (
                        <IonSelectOption key={opt.value} value={opt.value}>
                          {opt.label}
                        </IonSelectOption>
                      ))}
                    </IonSelect>
                  </IonItem>
                </div>
                {allergies.length > 0 && (
                  <div className="restriction-chip">
                    <IonIcon icon={checkmarkCircle} />
                    <IonLabel>
                      Preferences Applied
                      {` • ${allergies.length} allerg${allergies.length === 1 ? 'y' : 'ies'}`}
                    </IonLabel>
                  </div>
                )}

                </div>

                <div className="form-subsection targets-section">
                  <h3>Calorie and Macronutrient Goals</h3>

                <div className="form-group calorie-target-section">
                  <IonItem className="custom-item">
                    <IonLabel position="stacked">
                      <IonIcon icon={flame} /> Daily Calorie Target (kcal)
                    </IonLabel>
                    <IonInput
                      type="number"
                      value={calorieTarget}
                      onIonInput={(e) => {
                        const parsed = Number(e.detail.value);
                        if (Number.isFinite(parsed)) {
                          setCalorieTarget(parsed);
                        }
                      }}
                      className="custom-input"
                      placeholder="2000"
                    />
                  </IonItem>
                </div>

                  <IonGrid className="targets-grid">
                    <IonRow>
                      <IonCol size="12" sizeMd="4">
                        <IonItem className="custom-item">
                          <IonLabel position="stacked">Protein (g)</IonLabel>
                          <IonInput
                            type="number"
                            value={proteinTarget}
                            onIonInput={(e) => setProteinTarget(Number(e.detail.value) || 120)}
                            className="custom-input"
                          />
                        </IonItem>
                      </IonCol>
                      <IonCol size="12" sizeMd="4">
                        <IonItem className="custom-item">
                          <IonLabel position="stacked">Carbs (g)</IonLabel>
                          <IonInput
                            type="number"
                            value={carbsTarget}
                            onIonInput={(e) => setCarbsTarget(Number(e.detail.value) || 250)}
                            className="custom-input"
                          />
                        </IonItem>
                      </IonCol>
                      <IonCol size="12" sizeMd="4">
                        <IonItem className="custom-item">
                          <IonLabel position="stacked">Fats (g)</IonLabel>
                          <IonInput
                            type="number"
                            value={fatsTarget}
                            onIonInput={(e) => setFatsTarget(Number(e.detail.value) || 65)}
                            className="custom-input"
                          />
                        </IonItem>
                      </IonCol>
                    </IonRow>
                  </IonGrid>
                </div>

                <div className="form-subsection">
                  <h3>Socioeconomic Status and Budget</h3>
                  <div className="form-group">
                    <IonItem className="custom-item">
                      <IonLabel position="stacked">Budget Level</IonLabel>
                      <IonSelect value={socioeconomicStatus} onIonChange={(e) => setSocioeconomicStatus(e.detail.value || "middle")}>
                        {SOCIOECONOMIC_LEVELS.map((opt) => (
                          <IonSelectOption key={opt.value} value={opt.value}>
                            {opt.label}
                          </IonSelectOption>
                        ))}
                      </IonSelect>
                    </IonItem>
                  </div>
                  <div className="form-group">
                    <IonItem className="custom-item">
                      <IonLabel position="stacked">Daily Budget (PHP)</IonLabel>
                      <IonInput
                        type="number"
                        value={dailyBudgetPhp}
                        onIonInput={(e) => setDailyBudgetPhp(Number(e.detail.value) || 250)}
                        className="custom-input"
                      />
                    </IonItem>
                  </div>
                </div>

                <div className="form-subsection">
                  <h3>Lifestyle Factors</h3>
                  <div className="form-group">
                    <IonItem className="custom-item">
                      <IonLabel position="stacked">Smoking</IonLabel>
                      <IonSelect value={smokingStatus} onIonChange={(e) => setSmokingStatus(e.detail.value || "none")}>
                        {SMOKING_OPTIONS.map((opt) => (
                          <IonSelectOption key={opt.value} value={opt.value}>
                            {opt.label}
                          </IonSelectOption>
                        ))}
                      </IonSelect>
                    </IonItem>
                  </div>
                  <div className="form-group">
                    <IonItem className="custom-item">
                      <IonLabel position="stacked">Alcohol</IonLabel>
                      <IonSelect value={alcoholIntake} onIonChange={(e) => setAlcoholIntake(e.detail.value || "none")}>
                        {ALCOHOL_OPTIONS.map((opt) => (
                          <IonSelectOption key={opt.value} value={opt.value}>
                            {opt.label}
                          </IonSelectOption>
                        ))}
                      </IonSelect>
                    </IonItem>
                  </div>
                </div>

                <div className="button-group">
                  <IonButton
                    expand="block"
                    onClick={generateMealPlan}
                    disabled={loading}
                    className="generate-btn"
                  >
                    {loading ? (
                      <>
                        <IonSpinner name="crescent" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <IonIcon icon={calendar} slot="start" />
                        Generate 7-Day Plan
                      </>
                    )}
                  </IonButton>

                  {savedPlans.length > 0 && (
                    <IonButton
                      expand="block"
                      fill="outline"
                      onClick={() => setShowSavedPlans(true)}
                      className="secondary-btn"
                    >
                      <IonIcon icon={documents} slot="start" />
                      View Saved Plans ({savedPlans.length})
                    </IonButton>
                  )}
                </div>
              </IonCardContent>
            </IonCard>
          </div>
        )}

        {/* Generated Meal Plan */}
        {mealPlan && !showPreferencesForm && (
          <div className="meal-plan-display">
            
            <div className="plan-header-card">
              <div className="success-badge">✅</div>
              <h2 className="plan-title">Your 7-Day Meal Plan</h2>
              <p className="plan-subtitle">
                <IonIcon icon={flame} />
                {planStats.avgCalories} cal/day
                &nbsp;•&nbsp;
                <IonIcon icon={nutrition} />
                {planStats.avgProtein}g protein (avg)
              </p>

              <IonGrid className="action-buttons">
                <IonRow>
                  <IonCol size="16" sizeMd="6">
                    <IonButton
                      expand="block"
                      className="primary-btn"
                      onClick={() => setShowSaveModal(true)}
                      disabled={loading || !mealPlan}
                    >
                      <IonIcon icon={save} slot="start" />
                      {currentPlanId ? "Update Plan" : "Save Plan"}
                    </IonButton>
                  </IonCol>

                  <IonCol size="12" sizeMd="6">
                    <IonButton
                      expand="block"
                      className="secondary-btn"
                      onClick={() => {
                        setShowPreferencesForm(true);
                        setMealPlan(null);
                        setActiveTab("today");
                        setCurrentPlanId(null);
                      }}
                    >
                      <IonIcon icon={refresh} slot="start" />
                      New Plan
                    </IonButton>
                  </IonCol>
                </IonRow>
              </IonGrid>
            </div>

            {Array.isArray(mealPlan.evidenceSummary) && mealPlan.evidenceSummary.length > 0 && (
              <IonCard className="info-card evidence-card">
                <IonCardHeader>
                  <IonCardTitle><IonIcon icon={checkmarkCircle} /> Suitability Basis</IonCardTitle>
                </IonCardHeader>
                <IonCardContent>
                  <ul className="tips-list">
                    {mealPlan.evidenceSummary.map((note, idx) => (
                      <li key={idx}><IonIcon icon={listCircle} className="tip-icon" /><span>{note}</span></li>
                    ))}
                  </ul>
                </IonCardContent>
              </IonCard>
            )}

            {/* MODERN UI: Summary Bar + Day Selector - DISABLED */}
            {/* 
            {mealPlan?.weekPlan && mealPlan.weekPlan.length > 0 && (
            <div style={{ padding: "0 12px", marginBottom: "12px" }}>
              <SummaryBar calories={planStats.avgCalories} protein={planStats.avgProtein} />
              <DaySelector
                days={daysOfWeek}
                value={selectedDayName}
                onChange={(day) => {
                  setSelectedDayName(day);
                  setActiveTab("today");
                }}
                scrollRef={dayScrollRef}
              />
            </div>
            )}
            */}

            {/* Segment Control + View Toggle */}
            <div className="segment-wrapper">
              <IonSegment value={activeTab} onIonChange={(e) => setActiveTab(e.detail.value as "today" | "week")}>
                <IonSegmentButton value="today">
                  <IonIcon icon={time} />
                  Today
                </IonSegmentButton>
                <IonSegmentButton value="week">
                  <IonIcon icon={calendar} />
                  Full Week
                </IonSegmentButton>
              </IonSegment>
            </div>

            {/* Today's Plan - Using Modern Accordions - DISABLED */}
            {/* 
            {activeTab === "today" && mealPlan?.weekPlan && (
              <div className="today-view" style={{ padding: "0 12px" }}>
                {mealPlan.weekPlan.map((dayPlan, idx) => {
                  if (dayPlan.day !== selectedDayName) return null;
                  return (
                    <div key={idx}>
                      ... accordion items ...
                    </div>
                  );
                })}
              </div>
            )}
            */}

            {/* Segment Control */}
            {/* (Segment moved above) */}

            {/* Daily View - Compact with Meal Category Tabs */}
            {activeTab === "today" && todayPlan && (
              <div className="daily-view-compact">
                {/* Summary Bar */}
                <div className="daily-summary-bar">
                  <div className="summary-item">
                    <div className="summary-label">Calories</div>
                    <div className="summary-value">{todayPlanTotals.calories}</div>
                  </div>
                  <div className="summary-item">
                    <div className="summary-label">Protein</div>
                    <div className="summary-value">{todayPlanTotals.protein}g</div>
                  </div>
                  <div className="summary-item">
                    <div className="summary-label">Carbs</div>
                    <div className="summary-value">{todayPlanTotals.carbs}g</div>
                  </div>
                  <div className="summary-item">
                    <div className="summary-label">Fats</div>
                    <div className="summary-value">{todayPlanTotals.fats}g</div>
                  </div>
                </div>

                {/* Meal Category Tabs */}
                <div className="daily-tabs-container">
                  <IonSegment
                    scrollable
                    value={selectedMealCategory}
                    onIonChange={(e) => setSelectedMealCategory(e.detail.value as typeof selectedMealCategory)}
                  >
                    {mealCategories.map((cat) => (
                      <IonSegmentButton key={cat} value={cat}>
                        <IonLabel>
                          {mealIcons[cat]} {cat.charAt(0).toUpperCase() + cat.slice(1)}
                        </IonLabel>
                      </IonSegmentButton>
                    ))}
                  </IonSegment>
                </div>

                {/* Meal Content for Selected Category */}
                <div className="daily-meal-content">
                  {selectedMealCategory === "breakfast" && todayPlan.meals.breakfast && (
                    <DailyMealCard meal={todayPlan.meals.breakfast} mealType="breakfast" day={todayPlan.day} />
                  )}
                  {selectedMealCategory === "lunch" && todayPlan.meals.lunch && (
                    <DailyMealCard meal={todayPlan.meals.lunch} mealType="lunch" day={todayPlan.day} />
                  )}
                  {selectedMealCategory === "dinner" && todayPlan.meals.dinner && (
                    <DailyMealCard meal={todayPlan.meals.dinner} mealType="dinner" day={todayPlan.day} />
                  )}
                  {selectedMealCategory === "snacks" && (
                    <div className="snacks-container">
                      {todayPlan.meals.snack1 && <DailyMealCard meal={todayPlan.meals.snack1} mealType="snack1" day={todayPlan.day} />}
                      {todayPlan.meals.snack2 && <DailyMealCard meal={todayPlan.meals.snack2} mealType="snack2" day={todayPlan.day} />}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Weekly Grid View - Calendar Style */}
            {activeTab === "week" && mealPlan?.weekPlan && (
              <>
                {/* Desktop grid view */}
                <div className="weekly-grid-view">
                  <div className="week-grid-header">
                    <div className="grid-cell grid-header-cell"></div>
                    {daysOfWeek.map(day => (
                      <div key={day} className="grid-cell grid-header-cell">
                        <div className="day-header">{day.substring(0, 3)}</div>
                      </div>
                    ))}
                  </div>

                  {['breakfast', 'lunch', 'dinner', 'snacks'].map(mealType => (
                    <div key={mealType} className="week-grid-row">
                      <div className="grid-cell grid-meal-label">
                        <span className="meal-type-icon">{mealIcons[mealType]}</span>
                        <span className="meal-type-name">{mealType.charAt(0).toUpperCase() + mealType.slice(1)}</span>
                      </div>
                      {mealPlan.weekPlan.map(dayPlan => {
                        const meal =
                          mealType === 'breakfast'
                            ? dayPlan.meals.breakfast
                            : mealType === 'lunch'
                              ? dayPlan.meals.lunch
                              : mealType === 'dinner'
                                ? dayPlan.meals.dinner
                                : (dayPlan.meals.snack1 || dayPlan.meals.snack2);

                        return (
                          <div
                            key={`${dayPlan.day}-${mealType}`}
                            className="grid-cell grid-meal-cell"
                            onClick={() => {
                              setSelectedDayName(dayPlan.day);
                              setActiveTab("today");
                              if (mealType === 'breakfast') setSelectedMealCategory('breakfast');
                              else if (mealType === 'lunch') setSelectedMealCategory('lunch');
                              else if (mealType === 'dinner') setSelectedMealCategory('dinner');
                              else setSelectedMealCategory('snacks');
                            }}
                          >
                            {meal ? (
                              <div className="meal-grid-item">
                                <div className="meal-grid-name">{meal.name}</div>
                                <div className="meal-grid-calories">{calculateMealCalories449(meal)} cal</div>
                              </div>
                            ) : (
                              <div className="meal-grid-empty">-</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>

                {/* Mobile list view (no horizontal scroll) */}
                <div className="weekly-list-view">
                  <IonGrid fixed>
                    <IonRow>
                      {mealPlan.weekPlan.map((dayPlan) => (
                        <IonCol key={dayPlan.day} size="12" sizeMd="6">
                          <IonCard
                            className="week-day-card"
                            onClick={() => {
                              setSelectedDayName(dayPlan.day);
                              setActiveTab('today');
                            }}
                          >
                            <IonCardHeader>
                              <IonCardTitle>{dayPlan.day}</IonCardTitle>
                            </IonCardHeader>
                            <IonCardContent>
                              <div className="week-day-row">
                                <div className="week-day-label">Breakfast</div>
                                <div className="week-day-value">{dayPlan.meals.breakfast?.name ?? '-'}</div>
                              </div>
                              <div className="week-day-row">
                                <div className="week-day-label">Lunch</div>
                                <div className="week-day-value">{dayPlan.meals.lunch?.name ?? '-'}</div>
                              </div>
                              <div className="week-day-row">
                                <div className="week-day-label">Dinner</div>
                                <div className="week-day-value">{dayPlan.meals.dinner?.name ?? '-'}</div>
                              </div>
                              <div className="week-day-row">
                                <div className="week-day-label">Snacks</div>
                                <div className="week-day-value">
                                  {[dayPlan.meals.snack1?.name, dayPlan.meals.snack2?.name].filter(Boolean).join(' / ') || '-'}
                                </div>
                              </div>
                              <div className="week-day-totals">
                                <span>{dayPlan.totalCalories} cal</span>
                                <span>{dayPlan.totalProtein}g protein</span>
                              </div>
                            </IonCardContent>
                          </IonCard>
                        </IonCol>
                      ))}
                    </IonRow>
                  </IonGrid>
                </div>
              </>
            )}

            {/* Shopping List & Tips: handle normalized formats */}
            {mealPlan && (
              <IonCard className="info-card shopping-card">
                <IonCardHeader>
                  <IonCardTitle><IonIcon icon={cart} /> Shopping List</IonCardTitle>
                </IonCardHeader>
                <IonCardContent>
                  <div className="shopping-list">
                    {(() => {
                      const grouped = mealPlan.shoppingList && !Array.isArray(mealPlan.shoppingList) ? mealPlan.shoppingList : null;
                      const flat = grouped?.flat ?? [];
                      const groupedCount =
                        (grouped?.proteins?.length || 0) +
                        (grouped?.vegetables?.length || 0) +
                        (grouped?.carbs?.length || 0) +
                        (grouped?.others?.length || 0);
                      const arrayCount = Array.isArray(mealPlan.shoppingList) ? mealPlan.shoppingList.length : 0;
                      const flatCount = Array.isArray(flat) ? flat.length : 0;
                      const totalCount = groupedCount + arrayCount + flatCount;

                      if (totalCount > 0) return null;
                      return <p>No shopping list available yet.</p>;
                    })()}

                    {/* If server returned grouped object */}
                    {mealPlan.shoppingList && !Array.isArray(mealPlan.shoppingList) && (
                      <>
                        {(mealPlan.shoppingList as any).flat?.length > 0 && (
                          <div className="shopping-category">
                            <h4><IonIcon icon={cart} /> Ingredients</h4>
                            <ul className="shopping-items">
                              {(mealPlan.shoppingList as any).flat.map((item: any, idx: number) => (
                                <li key={idx}>
                                  <IonIcon icon={checkmarkCircle} className="check-icon" />
                                  <span>{formatShoppingItemLabel(item)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {mealPlan.shoppingList.proteins?.length > 0 && (
                          <div className="shopping-category">
                            <h4><IonIcon icon={nutrition} /> Proteins</h4>
                            <ul className="shopping-items">
                              {mealPlan.shoppingList.proteins.map((item: any, idx: number) => (
                                <li key={idx}><IonIcon icon={checkmarkCircle} className="check-icon" /><span>{item}</span></li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {mealPlan.shoppingList.vegetables?.length > 0 && (
                          <div className="shopping-category">
                            <h4><IonIcon icon={nutrition} /> Vegetables</h4>
                            <ul className="shopping-items">
                              {mealPlan.shoppingList.vegetables.map((item: any, idx: number) => (
                                <li key={idx}><IonIcon icon={checkmarkCircle} className="check-icon" /><span>{item}</span></li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {mealPlan.shoppingList.carbs?.length > 0 && (
                          <div className="shopping-category">
                            <h4><IonIcon icon={nutrition} /> Carbs</h4>
                            <ul className="shopping-items">
                              {mealPlan.shoppingList.carbs.map((item: any, idx: number) => (
                                <li key={idx}><IonIcon icon={checkmarkCircle} className="check-icon" /><span>{item}</span></li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {mealPlan.shoppingList.others?.length > 0 && (
                          <div className="shopping-category">
                            <h4><IonIcon icon={nutrition} /> Others</h4>
                            <ul className="shopping-items">
                              {mealPlan.shoppingList.others.map((item: any, idx: number) => (
                                <li key={idx}><IonIcon icon={checkmarkCircle} className="check-icon" /><span>{item}</span></li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}

                    {/* If server returned flat array like [{ingredient, estimate}] */}
                    {mealPlan.shoppingList && Array.isArray(mealPlan.shoppingList) && (
                      <div className="shopping-category">
                        <h4><IonIcon icon={cart} /> Ingredients</h4>
                        <ul className="shopping-items">
                          {mealPlan.shoppingList.map((item: any, idx: number) => (
                            <li key={idx}><IonIcon icon={checkmarkCircle} className="check-icon" /><span>{formatShoppingItemLabel(item)}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </IonCardContent>
              </IonCard>
            )}

            {/* Meal Prep Tips & Nutrition Tips */}
            {mealPlan && (
              <IonCard className="info-card tips-card">
                <IonCardHeader>
                  <IonCardTitle><IonIcon icon={bulb} /> Meal Prep Tips</IonCardTitle>
                </IonCardHeader>
                <IonCardContent>
                  {Array.isArray(mealPlan.mealPrepTips) && mealPlan.mealPrepTips.length > 0 ? (
                    <ul className="tips-list">
                      {mealPlan.mealPrepTips.map((tip, idx) => (
                        <li key={idx}><IonIcon icon={listCircle} className="tip-icon" /><span>{tip}</span></li>
                      ))}
                    </ul>
                  ) : (
                    <p>No meal prep tips available yet.</p>
                  )}
                </IonCardContent>
              </IonCard>
            )}

            {mealPlan && Array.isArray(mealPlan.citations) && mealPlan.citations.length > 0 && (
              <IonCard className="info-card citations-card">
                <IonCardHeader>
                  <IonCardTitle><IonIcon icon={documents} /> Sources</IonCardTitle>
                </IonCardHeader>
                <IonCardContent>
                  <ul className="source-list">
                    {mealPlan.citations.map((source) => (
                      <li key={source.id}>
                        <a href={source.url} target="_blank" rel="noreferrer">
                          {source.organization}: {source.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </IonCardContent>
              </IonCard>
            )}
          </div>
        )}

        {/* Regenerate Modal */}
        <IonModal isOpen={showEditModal} onDidDismiss={() => setShowEditModal(false)} className="custom-modal">
          <IonHeader className="modal-header">
            <IonToolbar>
              <IonTitle>Regenerate Meal</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setShowEditModal(false)}>
                  <IonIcon icon={close} />
                </IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="mp-modal-content">
            {editingMeal && (
              <div className="modal-content">
                <p className="modal-info">
                  Regenerating: <strong>{mealPlan?.weekPlan[editingMeal.dayIndex]?.day} - {editingMeal.mealType}</strong>
                </p>
                <p className="modal-description">
                  This will generate a DIFFERENT Filipino dish while keeping the same preferences and constraints.
                </p>
              </div>
            )}
          </IonContent>

          {editingMeal && (
            <IonFooter>
              <div className="mp-modal-actions">
                <IonButton
                  expand="block"
                  color="warning"
                  onClick={async () => {
                    await regenerateMeal(editingMeal.dayIndex, editingMeal.mealType);
                  }}
                  disabled={loading}
                  className="regenerate-btn"
                >
                  {loading ? (
                    <>
                      <IonSpinner name="crescent" />
                      Regenerating...
                    </>
                  ) : (
                    <>
                      <IonIcon icon={refresh} slot="start" />
                      Generate Different Meal
                    </>
                  )}
                </IonButton>

                <IonButton expand="block" fill="outline" color="medium" onClick={() => setShowEditModal(false)}>
                  Cancel
                </IonButton>
              </div>
            </IonFooter>
          )}
        </IonModal>

        {/* Recipe Modal */}
        <IonModal isOpen={showRecipeModal} onDidDismiss={() => setShowRecipeModal(false)} className="custom-modal">
          <IonHeader className="modal-header">
            <IonToolbar>
              <IonTitle>{selectedMeal?.meal.name}</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setShowRecipeModal(false)}>
                  <IonIcon icon={close} />
                </IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="mp-modal-content recipe-modal">
            {selectedMeal && (
              <div className="recipe-content">
                <h3 className="recipe-title">{selectedMeal.day} - {selectedMeal.mealType.toUpperCase()}</h3>
                
                <div className="recipe-macros">
                  <div className="macro-card">
                    <span className="macro-icon">🔥</span>
                    <span className="macro-value">{calculateMealCalories449(selectedMeal.meal)} cal</span>
                  </div>
                  <div className="macro-card">
                    <span className="macro-icon">💪</span>
                    <span className="macro-value">{selectedMeal.meal.protein}g</span>
                  </div>
                  <div className="macro-card">
                    <span className="macro-icon">🍚</span>
                    <span className="macro-value">{selectedMeal.meal.carbs}g</span>
                  </div>
                  <div className="macro-card">
                    <span className="macro-icon">🥑</span>
                    <span className="macro-value">{selectedMeal.meal.fats}g</span>
                  </div>
                </div>

                <div className="recipe-section">
                  <h4 className="section-heading">📍 Portion Size</h4>
                  <p className="recipe-text">{normalizePortionSize(selectedMeal.meal.portionSize)}</p>
                </div>

                <div className="recipe-section">
                  <h4 className="section-heading">🛒 Ingredients</h4>
                  <ul className="ingredients-list">
                    {recipeIngredients.map((ing, idx) => (
                      <li key={idx}>{ing}</li>
                    ))}
                  </ul>
                </div>

                {Array.isArray(selectedMeal.meal.suitabilityNotes) && selectedMeal.meal.suitabilityNotes.length > 0 && (
                  <div className="recipe-section">
                    <h4 className="section-heading">Suitability Notes</h4>
                    <ul className="ingredients-list">
                      {selectedMeal.meal.suitabilityNotes.map((note: string, idx: number) => (
                        <li key={idx}>{note}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {Array.isArray(selectedMeal.meal.citationIds) && selectedMeal.meal.citationIds.length > 0 && (
                  <div className="recipe-section">
                    <h4 className="section-heading">Sources</h4>
                    <ul className="source-list compact">
                      {selectedMeal.meal.citationIds.map((citationId: string) => {
                        const source = getCitationById(citationId);
                        if (!source) return null;
                        return (
                          <li key={citationId}>
                            <a href={source.url} target="_blank" rel="noreferrer">
                              {source.organization}: {source.title}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {selectedMeal.meal.recipe && selectedMeal.meal.recipe.trim() !== '' && (
                  <div className="recipe-section">
                    <h4 className="section-heading">👨‍🍳 Cooking Instructions</h4>
                    <div className="recipe-instructions">
                      {selectedMeal.meal.recipe.split('\n').filter((line: string) => line.trim()).map((line: string, idx: number) => (
                        <p key={idx} className="instruction-step">{line}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </IonContent>
        </IonModal>

        {/* Save Modal */}
        <IonModal isOpen={showSaveModal} onDidDismiss={() => setShowSaveModal(false)} className="custom-modal">
          <IonHeader className="modal-header">
            <IonToolbar>
              <IonTitle>Save Meal Plan</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setShowSaveModal(false)}>
                  <IonIcon icon={close} />
                </IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="mp-modal-content">
            <IonItem>
              <IonLabel position="stacked">Plan name</IonLabel>
              <IonInput
                value={planName}
                placeholder="e.g., High Protein Week"
                onIonChange={(e: any) => setPlanName(e.detail?.value as string)}
              />
            </IonItem>
          </IonContent>

          <IonFooter>
            <div className="mp-modal-actions">
              <IonButton
                expand="block"
                color="primary"
                onClick={async () => {
                  await saveMealPlan();
                }}
                disabled={!mealPlan}
              >
                <IonIcon icon={save} slot="start" />
                Save
              </IonButton>

              <IonButton expand="block" color="medium" fill="outline" onClick={() => setShowSaveModal(false)}>
                Cancel
              </IonButton>
            </div>
          </IonFooter>
        </IonModal>

        {/* Saved Plans Modal */}
        <IonModal isOpen={showSavedPlans} onDidDismiss={() => setShowSavedPlans(false)} className="custom-modal">
          <IonHeader className="modal-header">
            <IonToolbar>
              <IonTitle>Saved Meal Plans</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setShowSavedPlans(false)}>
                  <IonIcon icon={close} />
                </IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="mp-modal-content">
            <div className="saved-plans-list">
              {savedPlans.length === 0 ? (
                <div className="empty-state">
                  <p>No saved plans yet</p>
                </div>
              ) : (
                savedPlans.map((plan) => (
                  <IonCard key={plan.id} className="saved-plan-card">
                    <IonCardContent>
                      <h3 className="saved-plan-name">{plan.plan_name}</h3>
                      <p className="saved-plan-date">
                        <IonIcon icon={time} />
                        {new Date(plan.generated_at).toLocaleDateString()}
                      </p>
                      <div className="saved-plan-actions">
                        <IonButton size="small" onClick={() => loadSavedPlan(plan)} className="load-btn">
                          <IonIcon icon={eye} slot="start" />
                          Load
                        </IonButton>
                        <IonButton
                          size="small"
                          color="danger"
                          onClick={() => {
                            setPlanToDelete(plan.id);
                            setShowDeleteAlert(true);
                          }}
                          className="delete-btn"
                        >
                          <IonIcon icon={trash} slot="start" />
                          Delete
                        </IonButton>
                      </div>
                    </IonCardContent>
                  </IonCard>
                ))                )}
            </div>
          </IonContent>
        </IonModal>

        {/* Delete Alert */}
        <IonAlert
          isOpen={showDeleteAlert}
          onDidDismiss={() => setShowDeleteAlert(false)}
          header={"Confirm Delete"}
          message={"Are you sure you want to delete this meal plan? This action cannot be undone."}
          buttons={[
            { text: "Cancel", role: "cancel" },
            {
              text: "Delete",
              handler: async () => {
                if (planToDelete !== null) {
                  await deleteMealPlan(planToDelete);
                  setPlanToDelete(null);
                }
              },
            },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default MealPlanner;

// Remove duplicate helper definitions at the bottom of the file (if any).
