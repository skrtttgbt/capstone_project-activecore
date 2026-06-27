import React, { useEffect, useState } from "react";
import {
  IonApp,
  IonRouterOutlet,
  IonSplitPane,
  setupIonicReact,
} from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import { Redirect, Route } from "react-router-dom";

/* Core Ionic CSS */
import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/padding.css";
import "@ionic/react/css/float-elements.css";
import "@ionic/react/css/text-alignment.css";
import "@ionic/react/css/text-transformation.css";
import "@ionic/react/css/flex-utils.css";
import "@ionic/react/css/display.css";

/* Theme variables */
import "./theme/variables.css";

/* Pages */
import Home from "./pages/Home";

/* Admin pages */
import AdminDashboard from "./pages/AdminDashboard";
import MembersManagement from "./pages/MembersManagement";
import AdminPendingPayments from "./pages/AdminPendingPayments";
import AdminAttendance from "./pages/AdminAttendance";
import EquipmentManagement from "./pages/EquipmentManagement";
import AdminPayments from "./pages/AdminPayments";

/* Member pages */
import MemberDashboard from "./pages/MemberDashboard";
import MyAttendance from "./pages/MyAttendance";
import Calorie from "./pages/Calorie";
import QrAttendance from "./pages/QrAttendance";
import ProgressTracker from "./pages/ProgressTracker";
import MuscleGainTracker from "./pages/MuscleGainTracker";
import MemberPayment from "./pages/MemberPayment";
import MealPlanner from "./pages/MealPlanner";

/* Payment pages */
import PaymentReturn from "./pages/PaymentReturn";
import PaymentSuccess from "./pages/PaymentSuccess";
import PaymentFailed from "./pages/PaymentFailed";

/* Shared pages */
import AccountSettings from "./pages/AccountSettings";

/* Components */
import AppMenu from "./components/AppMenu";

/* Services */
import { ensureToken } from "./services/auth.service";

setupIonicReact();

type UserRole = "admin" | "member";

type AuthState = {
  isAuthed: boolean;
  role: UserRole | "";
};

/**
 * Extracts the actual user object from different possible
 * API response structures.
 */
function getStoredUser(): any {
  const raw =
    localStorage.getItem("user") ||
    localStorage.getItem("currentUser");

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);

    return parsed?.user ?? parsed?.data ?? parsed;
  } catch (error) {
    console.error("Unable to parse stored user:", error);
    return null;
  }
}

/**
 * Converts different role formats into admin/member.
 */
function normalizeRole(rawRole: unknown): UserRole | "" {
  if (!rawRole) {
    return "";
  }

  let roleValue = rawRole;

  if (typeof rawRole === "object" && rawRole !== null) {
    roleValue =
      (rawRole as any)?.name ??
      (rawRole as any)?.role ??
      "";
  }

  const normalizedRole = String(roleValue)
    .trim()
    .toLowerCase();

  if (normalizedRole === "admin") {
    return "admin";
  }

  if (normalizedRole === "member") {
    return "member";
  }

  return "";
}

/**
 * Reads authentication information directly from localStorage.
 */
function readAuthState(): AuthState {
  const token =
    localStorage.getItem("token") ||
    localStorage.getItem("accessToken");

  const user = getStoredUser();

  const role = normalizeRole(
    user?.role ??
    user?.user_role ??
    user?.accountRole
  );

  return {
    isAuthed: Boolean(token && role),
    role,
  };
}

/**
 * Creates a protected route renderer.
 *
 * This uses a normal Route inside IonRouterOutlet instead of
 * placing a custom PrivateRoute component directly in the outlet.
 */
function protectedPage(
  Component: React.ComponentType<any>,
  requiredRole?: UserRole
) {
  return (routeProps: any) => {
    const auth = readAuthState();

    if (!auth.isAuthed) {
      return <Redirect to="/home" />;
    }

    if (requiredRole && auth.role !== requiredRole) {
      return (
        <Redirect
          to={auth.role === "admin" ? "/admin" : "/member"}
        />
      );
    }

    return <Component {...routeProps} />;
  };
}

const App: React.FC = () => {
  const [authState, setAuthState] = useState<AuthState>(
    readAuthState()
  );

  const [authInitialized, setAuthInitialized] =
    useState(false);

  /**
   * Updates authentication when localStorage changes
   * from another browser tab.
   */
  useEffect(() => {
    const handleStorageChange = () => {
      setAuthState(readAuthState());
    };

    window.addEventListener(
      "storage",
      handleStorageChange
    );

    return () => {
      window.removeEventListener(
        "storage",
        handleStorageChange
      );
    };
  }, []);

  /**
   * Updates authentication after login/logout in the
   * current browser tab.
   */
  useEffect(() => {
    const handleAuthChanged = () => {
      setAuthState(readAuthState());
    };

    window.addEventListener(
      "auth-changed",
      handleAuthChanged
    );

    return () => {
      window.removeEventListener(
        "auth-changed",
        handleAuthChanged
      );
    };
  }, []);

  /**
   * Initialize or restore authentication token.
   */
  useEffect(() => {
    let isMounted = true;

    const initializeAuthentication = async () => {
      try {
        await ensureToken();
      } catch (error) {
        console.warn("ensureToken failed:", error);
      } finally {
        if (!isMounted) {
          return;
        }

        setAuthState(readAuthState());
        setAuthInitialized(true);
      }
    };

    initializeAuthentication();

    return () => {
      isMounted = false;
    };
  }, []);

  if (!authInitialized) {
    return (
      <IonApp>
        <div
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            fontFamily: "sans-serif",
          }}
        >
          Loading ActiveCore...
        </div>
      </IonApp>
    );
  }

  return (
    <IonApp>
      <IonReactRouter>
        <IonSplitPane
          contentId="main"
          when={authState.isAuthed ? "lg" : false}
        >
          <AppMenu />

          <IonRouterOutlet id="main">
            {/* Public home/login route */}
            <Route
              exact
              path="/home"
              render={() => {
                const auth = readAuthState();

                if (!auth.isAuthed) {
                  return <Home />;
                }

                return (
                  <Redirect
                    to={
                      auth.role === "admin"
                        ? "/admin"
                        : "/member"
                    }
                  />
                );
              }}
            />

            {/* ========================= */}
            {/* Protected Admin Routes    */}
            {/* ========================= */}

            <Route
              exact
              path="/admin"
              render={protectedPage(
                AdminDashboard,
                "admin"
              )}
            />

            <Route
              exact
              path="/members-management"
              render={protectedPage(
                MembersManagement,
                "admin"
              )}
            />

            <Route
              exact
              path="/admin-payments"
              render={protectedPage(
                AdminPayments,
                "admin"
              )}
            />

            <Route
              exact
              path="/admin/payments/pending"
              render={protectedPage(
                AdminPendingPayments,
                "admin"
              )}
            />

            <Route
              exact
              path="/admin-attendance"
              render={protectedPage(
                AdminAttendance,
                "admin"
              )}
            />

            <Route
              exact
              path="/equipment-management"
              render={protectedPage(
                EquipmentManagement,
                "admin"
              )}
            />

            {/* ========================= */}
            {/* Protected Member Routes   */}
            {/* ========================= */}

            <Route
              exact
              path="/member"
              render={protectedPage(
                MemberDashboard,
                "member"
              )}
            />

            <Route
              exact
              path="/member/qr"
              render={protectedPage(
                QrAttendance,
                "member"
              )}
            />

            <Route
              exact
              path="/member/attendance"
              render={protectedPage(
                MyAttendance,
                "member"
              )}
            />

            <Route
              exact
              path="/member/calorie"
              render={protectedPage(
                Calorie,
                "member"
              )}
            />

            <Route
              exact
              path="/member/meal-planner"
              render={protectedPage(
                MealPlanner,
                "member"
              )}
            />

            <Route
              exact
              path="/member/progress"
              render={protectedPage(
                ProgressTracker,
                "member"
              )}
            />

            <Route
              exact
              path="/member/muscle-gain"
              render={protectedPage(
                MuscleGainTracker,
                "member"
              )}
            />

            <Route
              exact
              path="/member/payment"
              render={protectedPage(
                MemberPayment,
                "member"
              )}
            />

            {/* ========================= */}
            {/* Shared Protected Route    */}
            {/* ========================= */}

            <Route
              exact
              path="/account-settings"
              render={protectedPage(AccountSettings)}
            />

            {/* ========================= */}
            {/* Payment Callback Routes   */}
            {/* ========================= */}

            <Route
              exact
              path="/payment/success"
              component={PaymentReturn}
            />

            <Route
              exact
              path="/payment/failed"
              component={PaymentReturn}
            />

            <Route
              exact
              path="/member/payment/success"
              render={protectedPage(
                PaymentSuccess,
                "member"
              )}
            />

            <Route
              exact
              path="/member/payment/failed"
              render={protectedPage(
                PaymentFailed,
                "member"
              )}
            />

            {/* Root route */}
            <Route
              exact
              path="/"
              render={() => {
                const auth = readAuthState();

                if (!auth.isAuthed) {
                  return <Redirect to="/home" />;
                }

                return (
                  <Redirect
                    to={
                      auth.role === "admin"
                        ? "/admin"
                        : "/member"
                    }
                  />
                );
              }}
            />

            {/* Catch-all route */}
            <Route
              render={() => {
                const auth = readAuthState();

                if (!auth.isAuthed) {
                  return <Redirect to="/home" />;
                }

                return (
                  <Redirect
                    to={
                      auth.role === "admin"
                        ? "/admin"
                        : "/member"
                    }
                  />
                );
              }}
            />
          </IonRouterOutlet>
        </IonSplitPane>
      </IonReactRouter>
    </IonApp>
  );
};

export default App;