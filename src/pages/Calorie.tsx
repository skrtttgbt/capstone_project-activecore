import React, { useState } from "react";
import { useHistory } from "react-router-dom";
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonGrid,
  IonRow,
  IonCol,
  IonItem,
  IonLabel,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonMenuButton,
} from "@ionic/react";
import "./Calorie.css";

type GoalKey =
  | "maintain_weight"
  | "mild_weight_loss"
  | "weight_loss"
  | "extreme_weight_loss"
  | "mild_weight_gain"
  | "weight_gain";

type GoalComputation = {
  key: GoalKey;
  label: string;
  targetIntake: number;
};

type CalculationSummary = {
  bmr: number;
  maintenanceCalories: number;
};

const roundKcal = (value: number) => Math.round(value);

/**
 * WHO/FAO/UNU adult predictive equations used in FNRI-DOST/PDRI practice.
 * These adult equations are based on age, sex, and body weight.
 */
const computeFnriBmr = (
  gender: "male" | "female",
  age: number,
  weightKg: number,
): number => {
  if (gender === "male") {
    if (age <= 30) return 15.3 * weightKg + 679;
    if (age <= 60) return 11.6 * weightKg + 879;
    return 13.5 * weightKg + 487;
  }

  if (age <= 30) return 14.7 * weightKg + 496;
  if (age <= 60) return 8.7 * weightKg + 829;
  return 10.5 * weightKg + 596;
};

const clampFnriFloor = (
  gender: "male" | "female",
  intake: number,
): number => {
  const floor = gender === "male" ? 1500 : 1200;
  return Math.max(intake, floor);
};

const mapCalculatorGoalToMealPlanner = (
  goalKey: GoalKey,
): "maintain" | "weight_loss" | "muscle_gain" => {
  if (
    goalKey === "mild_weight_loss" ||
    goalKey === "weight_loss" ||
    goalKey === "extreme_weight_loss"
  ) {
    return "weight_loss";
  }

  if (goalKey === "mild_weight_gain" || goalKey === "weight_gain") {
    return "muscle_gain";
  }

  return "maintain";
};

const Calorie: React.FC = () => {
  const history = useHistory();

  const [gender, setGender] = useState<"male" | "female">("male");
  const [age, setAge] = useState<number | "">("");
  const [weight, setWeight] = useState<number | "">("");
  const [activity, setActivity] = useState(1.4);
  const [errorMessage, setErrorMessage] = useState("");
  const [summary, setSummary] = useState<CalculationSummary | null>(null);
  const [computedGoals, setComputedGoals] = useState<GoalComputation[]>([]);
  const [selectedGoalKey, setSelectedGoalKey] =
    useState<GoalKey>("maintain_weight");

  const calculateCalories = () => {
    setErrorMessage("");

    if (!age || !weight) {
      setSummary(null);
      setComputedGoals([]);
      setErrorMessage("Please fill all fields correctly.");
      return;
    }

    if (Number(age) < 18) {
      setSummary(null);
      setComputedGoals([]);
      setErrorMessage(
        "FNRI-aligned WHO/FAO/UNU equations here are adult equations (18+). Please enter age 18 or above.",
      );
      return;
    }

    const ageValue = Number(age);
    const weightKg = Number(weight);
    const bmr = computeFnriBmr(gender, ageValue, weightKg);
    const maintenanceCalories = roundKcal(bmr * Number(activity));

    const goalAdjustments: Array<{
      key: GoalKey;
      label: string;
      delta: number;
    }> = [
      { key: "maintain_weight", label: "Maintain weight", delta: 0 },
      { key: "mild_weight_loss", label: "Mild weight loss", delta: -250 },
      { key: "weight_loss", label: "Weight loss", delta: -500 },
      {
        key: "extreme_weight_loss",
        label: "Extreme weight loss",
        delta: -750,
      },
      { key: "mild_weight_gain", label: "Mild weight gain", delta: 250 },
      { key: "weight_gain", label: "Weight gain", delta: 500 },
    ];

    const goals = goalAdjustments.map((goal) => ({
      key: goal.key,
      label: goal.label,
      targetIntake: roundKcal(
        clampFnriFloor(gender, maintenanceCalories + goal.delta),
      ),
    }));

    setSummary({
      bmr: roundKcal(bmr),
      maintenanceCalories,
    });
    setComputedGoals(goals);
    setSelectedGoalKey("maintain_weight");
  };

  const continueToMealPlanner = () => {
    const selectedGoal = computedGoals.find(
      (goal) => goal.key === selectedGoalKey,
    );

    if (!selectedGoal || !summary) return;

    const mealPlannerGoal = mapCalculatorGoalToMealPlanner(selectedGoal.key);

    // Frontend-only transfer. Nothing is saved to the backend here.
    sessionStorage.setItem(
      "mealPlannerCalorieRecommendation",
      JSON.stringify({
        calories: selectedGoal.targetIntake,
        calculatorGoal: selectedGoal.key,
        mealPlannerGoal,
        label: selectedGoal.label,
        bmr: summary.bmr,
        maintenanceCalories: summary.maintenanceCalories,
      }),
    );

    const query = new URLSearchParams({
      recommendedCalories: String(selectedGoal.targetIntake),
      recommendedGoal: mealPlannerGoal,
    });

    history.push(`/member/meal-planner?${query.toString()}`);
  };

  const selectedGoal = computedGoals.find(
    (goal) => goal.key === selectedGoalKey,
  );

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>
          <IonTitle>Calorie Calculator</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding">
        <IonGrid fixed>
          <IonRow className="ion-justify-content-center">
            <IonCol size="12" sizeMd="8" sizeLg="6">
              <IonCard className="container">
                <IonCardContent>
                  <h2>Calorie Calculator</h2>

                  <IonItem lines="full">
                    <IonLabel position="stacked">Gender</IonLabel>
                    <IonSelect
                      value={gender}
                      onIonChange={(event) => setGender(event.detail.value)}
                    >
                      <IonSelectOption value="male">Male</IonSelectOption>
                      <IonSelectOption value="female">Female</IonSelectOption>
                    </IonSelect>
                  </IonItem>

                  <IonRow>
                    <IonCol size="12" sizeMd="6">
                      <IonItem lines="full">
                        <IonLabel position="stacked">Age (years)</IonLabel>
                        <IonInput
                          type="number"
                          inputMode="numeric"
                          value={age}
                          onIonInput={(event) =>
                            setAge(
                              event.detail.value
                                ? Number(event.detail.value)
                                : "",
                            )
                          }
                        />
                      </IonItem>
                    </IonCol>

                    <IonCol size="12" sizeMd="6">
                      <IonItem lines="full">
                        <IonLabel position="stacked">Weight (kg)</IonLabel>
                        <IonInput
                          type="number"
                          inputMode="decimal"
                          value={weight}
                          onIonInput={(event) =>
                            setWeight(
                              event.detail.value
                                ? Number(event.detail.value)
                                : "",
                            )
                          }
                        />
                      </IonItem>
                    </IonCol>
                  </IonRow>

                  <IonItem lines="full">
                    <IonLabel position="stacked">Activity Level</IonLabel>
                    <IonSelect
                      value={activity}
                      onIonChange={(event) =>
                        setActivity(Number(event.detail.value))
                      }
                    >
                      <IonSelectOption value={1.4}>
                        Sedentary (PAL 1.40)
                      </IonSelectOption>
                      <IonSelectOption value={1.55}>
                        Low Active (PAL 1.55)
                      </IonSelectOption>
                      <IonSelectOption value={1.75}>
                        Active (PAL 1.75)
                      </IonSelectOption>
                      <IonSelectOption value={2.0}>
                        Very Active (PAL 2.00)
                      </IonSelectOption>
                    </IonSelect>
                  </IonItem>

                  <div className="pal-help">
                    <small>
                      PAL = Physical Activity Level. Choose the value that best
                      matches your typical daily activity.
                    </small>
                  </div>

                  <IonButton expand="block" onClick={calculateCalories}>
                    Calculate
                  </IonButton>

                  {errorMessage && (
                    <p style={{ color: "red" }}>⚠️ {errorMessage}</p>
                  )}

                  {summary && computedGoals.length > 0 && (
                    <div className="results">
                      <div className="card">
                        <strong>Basal Metabolic Rate (BMR)</strong>
                        <span className="highlight">
                          {summary.bmr} Calories/day
                        </span>
                      </div>

                      <div className="card">
                        <strong>Maintenance calories</strong>
                        <span className="highlight">
                          {summary.maintenanceCalories} Calories/day
                        </span>
                      </div>

                      {computedGoals.map((goal) => (
                        <div className="card" key={goal.key}>
                          <strong>{goal.label}</strong>
                          <span className="highlight">
                            {goal.targetIntake} Calories/day
                          </span>
                        </div>
                      ))}

                      <IonItem lines="full">
                        <IonLabel position="stacked">
                          Recommended calories to use in Meal Planner
                        </IonLabel>
                        <IonSelect
                          value={selectedGoalKey}
                          onIonChange={(event) =>
                            setSelectedGoalKey(event.detail.value as GoalKey)
                          }
                        >
                          {computedGoals.map((goal) => (
                            <IonSelectOption key={goal.key} value={goal.key}>
                              {goal.label} — {goal.targetIntake} kcal/day
                            </IonSelectOption>
                          ))}
                        </IonSelect>
                      </IonItem>

                      <IonButton
                        expand="block"
                        onClick={continueToMealPlanner}
                        disabled={!selectedGoal}
                      >
                        Go to Meal Planner
                        {selectedGoal
                          ? ` — ${selectedGoal.targetIntake} kcal/day`
                          : ""}
                      </IonButton>

                      <div className="card">
                        <strong>Method note</strong>
                        <span>
                          FNRI-aligned WHO/FAO/UNU adult equations use age,
                          sex, weight, and PAL. Height is not required in this
                          method.
                        </span>
                      </div>
                    </div>
                  )}
                </IonCardContent>
              </IonCard>
            </IonCol>
          </IonRow>
        </IonGrid>
      </IonContent>
    </IonPage>
  );
};

export default Calorie;
