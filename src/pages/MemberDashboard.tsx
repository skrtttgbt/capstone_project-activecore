import React, { useCallback, useEffect, useState } from "react";
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
  IonIcon,
  IonButtons,
  IonMenuButton,
  IonGrid,
  IonRow,
  IonCol,
  IonCard,
  IonCardContent,
  IonItem,
  IonLabel,
  IonSelect,
  IonSelectOption,
  useIonRouter,
} from "@ionic/react";
import {
  qrCode,
  calculator,
  restaurant,
  trendingUp,
  barbell,
  logOut,
  calendar,
  flame,
  cardOutline,
} from "ionicons/icons";
import "./MemberDashboard.css";
import { logout } from "../services/auth.service";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

import { API_CONFIG } from "../config/api.config";

const API_URL = API_CONFIG.BASE_URL;

type AbsenceStatus = {
  lastAttendanceDate: string | null;
  daysSinceLastAttendance: number | null;
  thresholdDays: number;
  isAbsent: boolean;
};

const ABSENCE_REMINDER_NOTIFICATION_ID = 91001;
const DEFAULT_ABSENCE_THRESHOLD_DAYS = 1;
const DEFAULT_REMINDER_HOUR = 8;
const DEFAULT_REMINDER_MINUTE = 0;

const MemberDashboard: React.FC = () => {
  const [firstName, setFirstName] = useState("John");
  const [streak, setStreak] = useState<number>(0); // added
  const [motivation, setMotivation] = useState<string>(''); // added
  const [absenceStatus, setAbsenceStatus] = useState<AbsenceStatus | null>(null);
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(() => {
    const raw = localStorage.getItem('absenceReminderEnabled');
    return raw !== 'false';
  });
  const [thresholdDays, setThresholdDays] = useState<number>(() => {
    const raw = localStorage.getItem('absenceReminderThresholdDays');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ABSENCE_THRESHOLD_DAYS;
  });
  const [reminderHour, setReminderHour] = useState<number>(() => {
    const raw = localStorage.getItem('absenceReminderHour');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : DEFAULT_REMINDER_HOUR;
  });
  const [reminderMinute, setReminderMinute] = useState<number>(() => {
    const raw = localStorage.getItem('absenceReminderMinute');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 59 ? parsed : DEFAULT_REMINDER_MINUTE;
  });
  const [notificationPermission, setNotificationPermission] = useState<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');
  const router = useIonRouter();

  const persistAbsenceReminderSettings = useCallback(async (next: {
    enabled: boolean;
    thresholdDays: number;
    reminderHour: number;
    reminderMinute: number;
  }) => {
    // Always keep local cache so settings work offline.
    localStorage.setItem('absenceReminderEnabled', String(next.enabled));
    localStorage.setItem('absenceReminderThresholdDays', String(next.thresholdDays));
    localStorage.setItem('absenceReminderHour', String(next.reminderHour));
    localStorage.setItem('absenceReminderMinute', String(next.reminderMinute));

    const token = localStorage.getItem('token') || '';
    if (!token) return;

    try {
      await fetch(`${API_URL}/user/settings/absence-reminder`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(next),
      });
    } catch {
      // ignore: offline / backend unreachable
    }
  }, []);

  const loadAbsenceReminderSettings = useCallback(async () => {
    const token = localStorage.getItem('token') || '';
    if (!token) return;

    try {
      const res = await fetch(`${API_URL}/user/settings/absence-reminder`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok || !data?.success || !data?.settings) return;

      const s = data.settings;
      const enabled = Boolean(s.enabled);
      const nextThresholdDays = Number(s.thresholdDays);
      const hour = Number(s.reminderHour);
      const minute = Number(s.reminderMinute);

      const normalized = {
        enabled,
        thresholdDays: Number.isFinite(nextThresholdDays) && nextThresholdDays > 0 ? nextThresholdDays : DEFAULT_ABSENCE_THRESHOLD_DAYS,
        reminderHour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_REMINDER_HOUR,
        reminderMinute: Number.isFinite(minute) && minute >= 0 && minute <= 59 ? minute : DEFAULT_REMINDER_MINUTE,
      };

      setReminderEnabled(normalized.enabled);
      setThresholdDays(normalized.thresholdDays);
      setReminderHour(normalized.reminderHour);
      setReminderMinute(normalized.reminderMinute);

      // Update local cache to match server.
      await persistAbsenceReminderSettings(normalized);
    } catch {
      // ignore
    }
  }, [persistAbsenceReminderSettings]);

  const ensureNotificationPermission = useCallback(async (): Promise<boolean> => {
    if (!Capacitor.isNativePlatform()) return false;

    try {
      const current = await LocalNotifications.checkPermissions();
      const state = (current?.display as any) ?? 'prompt';
      setNotificationPermission(state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown');

      if (state === 'granted') return true;

      const requested = await LocalNotifications.requestPermissions();
      const requestedState = (requested?.display as any) ?? 'prompt';
      setNotificationPermission(
        requestedState === 'granted' || requestedState === 'denied' || requestedState === 'prompt' ? requestedState : 'unknown'
      );

      return requestedState === 'granted';
    } catch {
      setNotificationPermission('unknown');
      return false;
    }
  }, []);

  const cancelAbsenceReminder = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await LocalNotifications.cancel({ notifications: [{ id: ABSENCE_REMINDER_NOTIFICATION_ID }] });
    } catch {
      // ignore
    }
  }, []);

  const scheduleAbsenceReminder = useCallback(async (status: AbsenceStatus) => {
    if (!Capacitor.isNativePlatform()) return;
    if (!reminderEnabled) return;
    if (!status.isAbsent) return;

    const hasPerm = await ensureNotificationPermission();
    if (!hasPerm) return;

    const pending = await LocalNotifications.getPending();
    const exists = (pending?.notifications || []).some(n => n.id === ABSENCE_REMINDER_NOTIFICATION_ID);
    if (exists) return;

    const daysText = status.daysSinceLastAttendance === null
      ? `You haven't checked in yet.`
      : `You haven't checked in for ${status.daysSinceLastAttendance} day(s).`;

    await LocalNotifications.schedule({
      notifications: [
        {
          id: ABSENCE_REMINDER_NOTIFICATION_ID,
          title: 'ActiveCore Attendance Reminder',
          body: `${daysText} Time to train today!`,
          schedule: {
            at: new Date(Date.now() + 1000), // Schedule 1 second from now to trigger the repeating schedule
            repeats: true,
            every: 'day',
            allowWhileIdle: true,
          },
        },
      ],
    });
  }, [ensureNotificationPermission, reminderEnabled, reminderHour, reminderMinute]);

  const resyncAbsenceReminder = useCallback(async (status: AbsenceStatus | null) => {
    if (!Capacitor.isNativePlatform()) return;
    await cancelAbsenceReminder();
    if (status && reminderEnabled && status.isAbsent) {
      await scheduleAbsenceReminder(status);
    }
  }, [cancelAbsenceReminder, reminderEnabled, scheduleAbsenceReminder]);

  // Fetch attendance stats, absence status, and pick daily motivation
  const loadDashboardData = useCallback(async () => {
    try {
      const token = localStorage.getItem("token");
      if (!token) return;

      const [historyRes, absenceRes] = await Promise.all([
        fetch(`${API_URL}/attendance/history`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/attendance/absence-status?thresholdDays=${thresholdDays}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (historyRes.ok) {
        const data = await historyRes.json();
        if (data && data.stats) setStreak(data.stats.currentStreak || 0);
      }

      if (absenceRes.ok) {
        const abs = await absenceRes.json();
        if (abs && abs.success) {
          const status: AbsenceStatus = {
            lastAttendanceDate: abs.lastAttendanceDate ?? null,
            daysSinceLastAttendance:
              abs.daysSinceLastAttendance === null || abs.daysSinceLastAttendance === undefined
                ? null
                : Number(abs.daysSinceLastAttendance),
            thresholdDays: Number(abs.thresholdDays ?? DEFAULT_ABSENCE_THRESHOLD_DAYS),
            isAbsent: Boolean(abs.isAbsent),
          };
          setAbsenceStatus(status);

          if (Capacitor.isNativePlatform()) {
            await resyncAbsenceReminder(status);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    } finally {
      // Daily motivations list
      const motivations = [
        "One step at a time — your progress matters.",
        "Show up today. Your future self will thank you.",
        "Consistency beats intensity. Keep going!",
        "Small gains every day add up to big results.",
        "Fuel your body. Honor your training.",
        "Today's effort is tomorrow's strength.",
        "Discipline creates freedom — train for it."
      ];
      const idx = new Date().getDate() % motivations.length;
      setMotivation(motivations[idx]);
    }
  }, [resyncAbsenceReminder, thresholdDays]);

  useEffect(() => {
    const userStr = localStorage.getItem("user");
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        setFirstName(user.firstName);
      } catch (err) {
        console.error("Invalid user data in localStorage");
      }
    } else {
      router.push("/home", "root", "replace");
    }

    // Sync reminder settings (same account) then load dashboard.
    (async () => {
      // Request notification permission on app start if on native platform
      if (Capacitor.isNativePlatform()) {
        await ensureNotificationPermission();
      }
      await loadAbsenceReminderSettings();
      await loadDashboardData();
    })();
  }, [router, loadAbsenceReminderSettings, loadDashboardData]);

  const handleRequestNotificationPermission = async () => {
    await ensureNotificationPermission();
    if (absenceStatus && reminderEnabled) {
      await scheduleAbsenceReminder(absenceStatus);
    }
  };

  const handleTestNotification = async () => {
    if (!Capacitor.isNativePlatform()) {
      alert('Notifications only work on mobile devices');
      return;
    }

    const hasPerm = await ensureNotificationPermission();
    if (!hasPerm) {
      alert('Please grant notification permission first');
      return;
    }

    // Schedule a test notification for 5 seconds from now
    await LocalNotifications.schedule({
      notifications: [
        {
          id: 99999,
          title: 'Test Notification',
          body: 'This is a test notification from ActiveCore!',
          schedule: {
            at: new Date(Date.now() + 5000), // 5 seconds from now
            allowWhileIdle: true,
          },
        },
      ],
    });

    alert('Test notification scheduled! Check your device in 5 seconds.');
  };

  const handleToggleReminder = async () => {
    const next = !reminderEnabled;
    setReminderEnabled(next);
    await persistAbsenceReminderSettings({
      enabled: next,
      thresholdDays,
      reminderHour,
      reminderMinute,
    });

    if (!Capacitor.isNativePlatform()) return;

    await resyncAbsenceReminder(absenceStatus);
  };

  const handleThresholdChange = async (value: number) => {
    const next = Math.max(1, Number(value));
    setThresholdDays(next);
    await persistAbsenceReminderSettings({
      enabled: reminderEnabled,
      thresholdDays: next,
      reminderHour,
      reminderMinute,
    });
  };

  const handleTimePresetChange = async (preset: string) => {
    const map: Record<string, { hour: number; minute: number }> = {
      '06:00': { hour: 6, minute: 0 },
      '08:00': { hour: 8, minute: 0 },
      '18:00': { hour: 18, minute: 0 },
    };
    const next = map[preset] ?? { hour: DEFAULT_REMINDER_HOUR, minute: DEFAULT_REMINDER_MINUTE };
    setReminderHour(next.hour);
    setReminderMinute(next.minute);
    await persistAbsenceReminderSettings({
      enabled: reminderEnabled,
      thresholdDays,
      reminderHour: next.hour,
      reminderMinute: next.minute,
    });
  };

  useEffect(() => {
    // When settings change, refresh server status and resync local notification.
    loadDashboardData();
  }, [loadDashboardData]);

  const handleLogout = () => {
    logout();
    router.push("/home", "root", "replace");
  };

  const handleNavigation = (path: string) => {
    console.log(`Navigating to: ${path}`);
    router.push(path, "forward");
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>
          <IonTitle>Member Dashboard</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={handleLogout}>
              <IonIcon icon={logOut} slot="start" />
              Logout
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding">
        <div className="dashboard-content-wrapper">
          <IonGrid fixed>
            <IonRow>
              <IonCol size="12">
                <div className="page-header">
                  <div className="welcome-text">
                    <h1>Welcome back, {firstName}!</h1>
                    <p>Track your fitness journey and achieve your goals</p>
                  </div>

                  <div className="hero-motivation">
                    <div className="motivation-text">{motivation}</div>
                    <div className="streak-pill">
                      <IonIcon icon={flame} /> Streak: {streak} days
                    </div>
                  </div>
                </div>
              </IonCol>
            </IonRow>

            {absenceStatus?.isAbsent && (
              <IonRow>
                <IonCol size="12">
                  <IonCard className="absence-alert-card">
                    <IonCardContent>
                      <div className="absence-alert-content">
                        <div className="absence-alert-text">
                          <h3 className="absence-alert-title">We miss you at the gym</h3>
                          <p className="absence-alert-subtitle">
                            {absenceStatus.daysSinceLastAttendance === null
                              ? `You haven't checked in yet. Start your first check-in today!`
                              : `You haven't checked in for ${absenceStatus.daysSinceLastAttendance} day(s). Keep your momentum going.`}
                          </p>

                          <div className="absence-alert-settings">
                            <IonItem lines="none" className="absence-setting-item">
                              <IonLabel>Absent after</IonLabel>
                              <IonSelect
                                value={thresholdDays}
                                interface="popover"
                                onIonChange={(e) => handleThresholdChange(Number(e.detail.value))}
                              >
                                <IonSelectOption value={2}>2 days</IonSelectOption>
                                <IonSelectOption value={3}>3 days</IonSelectOption>
                                <IonSelectOption value={5}>5 days</IonSelectOption>
                                <IonSelectOption value={7}>7 days</IonSelectOption>
                              </IonSelect>
                            </IonItem>

                            {Capacitor.isNativePlatform() && (
                              <IonItem lines="none" className="absence-setting-item">
                                <IonLabel>Reminder time</IonLabel>
                                <IonSelect
                                  value={`${String(reminderHour).padStart(2, '0')}:${String(reminderMinute).padStart(2, '0')}`}
                                  interface="popover"
                                  onIonChange={(e) => handleTimePresetChange(String(e.detail.value))}
                                >
                                  <IonSelectOption value="06:00">6:00 AM</IonSelectOption>
                                  <IonSelectOption value="08:00">8:00 AM</IonSelectOption>
                                  <IonSelectOption value="18:00">6:00 PM</IonSelectOption>
                                </IonSelect>
                              </IonItem>
                            )}
                          </div>
                        </div>

                        <div className="absence-alert-actions">
                          <IonButton onClick={() => handleNavigation('/member/qr')}>
                            Check in now
                          </IonButton>

                          {Capacitor.isNativePlatform() && (
                            <>
                              <IonButton fill="outline" onClick={handleToggleReminder}>
                                {reminderEnabled ? 'Disable reminders' : 'Enable reminders'}
                              </IonButton>

                              {reminderEnabled && notificationPermission === 'denied' && (
                                <IonButton fill="outline" color="warning" onClick={handleRequestNotificationPermission}>
                                  Allow notifications
                                </IonButton>
                              )}

                              <IonButton fill="clear" color="secondary" onClick={handleTestNotification}>
                                Test notification
                              </IonButton>
                            </>
                          )}
                        </div>
                      </div>
                    </IonCardContent>
                  </IonCard>
                </IonCol>
              </IonRow>
            )}

            <IonRow>
              <IonCol size="12" sizeMd="6" sizeLg="4">
                <IonCard className="dashboard-card" onClick={() => handleNavigation("/member/qr")}>
                  <IonCardContent>
                    <IonIcon icon={qrCode} className="card-icon" />
                    <h3 className="card-title">QR Attendance</h3>
                    <p className="card-description">Scan to check-in</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>

              <IonCol size="12" sizeMd="6" sizeLg="4">
                <IonCard className="dashboard-card" onClick={() => handleNavigation("/member/calorie")}>
                  <IonCardContent>
                    <IonIcon icon={calculator} className="card-icon" />
                    <h3 className="card-title">Calorie Calculator</h3>
                    <p className="card-description">Track your calories</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>

              <IonCol size="12" sizeMd="6" sizeLg="4">
                <IonCard className="dashboard-card" onClick={() => handleNavigation("/member/meal-planner")}>
                  <IonCardContent>
                    <IonIcon icon={restaurant} className="card-icon" />
                    <h3 className="card-title">Meal Planner</h3>
                    <p className="card-description">Plan your meals</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>

              <IonCol size="12" sizeMd="6" sizeLg="4">
                <IonCard className="dashboard-card" onClick={() => handleNavigation("/member/progress")}>
                  <IonCardContent>
                    <IonIcon icon={trendingUp} className="card-icon" />
                    <h3 className="card-title">Progress Tracker</h3>
                    <p className="card-description">Track your progress</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>

              <IonCol size="12" sizeMd="6" sizeLg="4">
                <IonCard className="dashboard-card" onClick={() => handleNavigation("/member/muscle-gain")}>
                  <IonCardContent>
                    <IonIcon icon={barbell} className="card-icon" />
                    <h3 className="card-title">Muscle Gain</h3>
                    <p className="card-description">Build muscle</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>
            </IonRow>

            <IonRow>
              <IonCol size="12">
                <section className="progress-section">
                  <div className="progress-header">
                    <div>
                      <h2 className="progress-title">Daily Motivation</h2>
                      <p className="progress-subtitle">Short reminders to keep you consistent</p>
                    </div>
                  </div>

                  <IonGrid>
                    <IonRow>
                      {(() => {
                        const allMotivations = [
                          "One step at a time — your progress matters.",
                          "Show up today. Your future self will thank you.",
                          "Consistency beats intensity. Keep going!",
                          "Small gains every day add up to big results.",
                          "Fuel your body. Honor your training.",
                          "Today's effort is tomorrow's strength.",
                          "Discipline creates freedom — train for it.",
                        ];
                        const baseIdx = new Date().getDate() % allMotivations.length;
                        const mot1 = allMotivations[baseIdx];
                        const mot2 = allMotivations[(baseIdx + 1) % allMotivations.length];
                        const mot3 = allMotivations[(baseIdx + 2) % allMotivations.length];

                        return (
                          <>
                            <IonCol size="12" sizeMd="4">
                              <div className="progress-item motivation-card">
                                <IonIcon icon={calendar} style={{ fontSize: "2rem", color: "var(--primary-color)" }} />
                                <h4>Motivation</h4>
                                <p>{mot1}</p>
                              </div>
                            </IonCol>

                            <IonCol size="12" sizeMd="4">
                              <div className="progress-item motivation-card">
                                <IonIcon icon={flame} style={{ fontSize: "2rem", color: "var(--primary-color)" }} />
                                <h4>Tip</h4>
                                <p>{mot2}</p>
                              </div>
                            </IonCol>

                            <IonCol size="12" sizeMd="4">
                              <div className="progress-item motivation-card">
                                <IonIcon icon={trendingUp} style={{ fontSize: "2rem", color: "var(--primary-color)" }} />
                                <h4>Focus</h4>
                                <p>{mot3}</p>
                              </div>
                            </IonCol>
                          </>
                        );
                      })()}
                    </IonRow>
                  </IonGrid>
                </section>
              </IonCol>
            </IonRow>

            <IonRow className="renew-subscription-row">
              <IonCol size="12" sizeMd="8" sizeLg="6" className="renew-subscription-col">
                <IonButton
                  className="renew-subscription-btn"
                  expand="block"
                  color="primary"
                  onClick={() => handleNavigation('/member/payment')}
                >
                  <IonIcon icon={cardOutline} slot="start" />
                  Renew Subscription with PayPal
                </IonButton>
              </IonCol>
            </IonRow>
          </IonGrid>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default MemberDashboard;
