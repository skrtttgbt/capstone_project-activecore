import React, { useEffect, useState } from "react";
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonIcon,
  IonButtons,
  IonMenuButton,
  IonBadge,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  IonText,
  IonGrid,
  IonRow,
  IonCol,
} from "@ionic/react";
import {
  qrCodeOutline,
  refreshOutline,
  peopleOutline,
  timeOutline,
  calendarOutline,
  warningOutline,
} from "ionicons/icons";
import { QRCodeSVG } from "qrcode.react";
import "./AdminAttendance.css";

import { API_CONFIG } from "../config/api.config";
import { formatLocalDate, formatLocalTime } from "../utils/dateTime";

interface AttendanceRecord {
  id: number;
  userId: number;
  fullName: string;
  email: string;
  checkInTime: string;
  date?: string;
  time?: string;
  location: string;
  status: "present" | "late";
}

const API_URL = API_CONFIG.BASE_URL;

const AdminAttendance: React.FC = () => {
  const [qrToken, setQrToken] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [generatingQR, setGeneratingQR] = useState(false);

  useEffect(() => {
    generateQRCode();
    loadTodayAttendance();
  }, []);

  const generateQRCode = async () => {
    try {
      setGeneratingQR(true);
      const token = localStorage.getItem("token");
      
      if (!token) {
        alert("No authentication token found. Please login again.");
        return;
      }
      
      const url = `${API_URL}/admin/qr-token/generate`;
      console.log("📡 Calling:", url);
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ expiresInHours: 24 }),
      });

      console.log("📊 Response status:", response.status);
      
      const data = await response.json();
      console.log("📦 Response data:", data);

      if (data.success) {
        setQrToken(data.token);
        setExpiresAt(data.expiresAt);
        console.log("✅ QR Code generated:", data.token);
      } else {
        console.error("❌ Failed to generate QR code:", data.message);
        alert("Failed to generate QR code: " + (data.message || "Unknown error"));
      }
    } catch (error) {
      console.error("❌ Error generating QR code:", error);
      alert("Error: " + (error instanceof Error ? error.message : "Unknown error"));
    } finally {
      setGeneratingQR(false);
    }
  };

  const loadTodayAttendance = async () => {
    try {
      setLoading(true);
      const today = new Date().toISOString().split("T")[0];
      const response = await fetch(`${API_URL}/admin/attendance?date=${today}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });

      const data = await response.json();

      if (data.success) {
        setAttendanceRecords(data.attendance);
        console.log("✅ Loaded attendance:", data.attendance.length);
      }
    } catch (error) {
      console.error("❌ Error loading attendance:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async (event: CustomEvent) => {
    await loadTodayAttendance();
    event.detail.complete();
  };

  const formatExpiryTime = (expiryDate: string) => {
    if (!expiryDate) return "";
    const expiry = new Date(expiryDate);
    return expiry.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>
          <IonTitle>Attendance Management</IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={loadTodayAttendance}>
              <IonIcon icon={refreshOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>

      <IonContent className="admin-attendance-content" fullscreen>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent></IonRefresherContent>
        </IonRefresher>

        <div className="attendance-container">
          {/* Header Stats */}
          <div className="stats-header">
            <IonGrid>
              <IonRow>
                <IonCol size="12" sizeMd="12">
                  <IonCard className="stat-card">
                    <IonCardContent>
                      <div className="stat-content">
                        <IonIcon icon={peopleOutline} className="stat-icon primary" />
                        <div className="stat-info">
                          <h3>{attendanceRecords.length}</h3>
                          <p>Check-ins Today</p>
                        </div>
                      </div>
                    </IonCardContent>
                  </IonCard>
                </IonCol>
              </IonRow>
            </IonGrid>
          </div>

          {/* QR Code Section */}
          <IonCard className="qr-card">
            <IonCardHeader>
              <IonCardTitle className="qr-title">
                <IonIcon icon={qrCodeOutline} />
                Attendance QR Code
              </IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              <div className="qr-content">
                {generatingQR ? (
                  <div className="qr-loading">
                    <IonSpinner name="circular" />
                    <p>Generating QR Code...</p>
                  </div>
                ) : qrToken ? (
                  <>
                    <div className="qr-code-wrapper">
                      <div className="qr-code-container">
                        <QRCodeSVG
                          value={qrToken}
                          size={280}
                          level="H"
                          includeMargin={true}
                          bgColor="#ffffff"
                          fgColor="#000000"
                        />
                      </div>
                      <div className="qr-branding">
                        <IonIcon icon={qrCodeOutline} />
                        <span>ActiveCore Gym</span>
                      </div>
                    </div>
                    <div className="qr-info">
                      <div className="qr-status">
                        <IonBadge color="success">Active</IonBadge>
                        <span className="expiry-text">
                          <IonIcon icon={timeOutline} />
                          Expires: {formatExpiryTime(expiresAt)}
                        </span>
                      </div>
                      <IonText color="medium" className="qr-instructions">
                        <p>
                          📱 Members can scan this QR code using their mobile app to check in.
                          Display this on the gym entrance screen or print it out.
                        </p>
                      </IonText>
                      <IonButton
                        expand="block"
                        fill="outline"
                        onClick={generateQRCode}
                        disabled={generatingQR}
                      >
                        <IonIcon icon={refreshOutline} slot="start" />
                        Generate New QR Code
                      </IonButton>
                    </div>
                  </>
                ) : (
                  <div className="qr-empty">
                    <IonIcon icon={warningOutline} />
                    <p>No QR code available</p>
                    <IonButton onClick={generateQRCode}>
                      Generate QR Code
                    </IonButton>
                  </div>
                )}
              </div>
            </IonCardContent>
          </IonCard>

          {/* Attendance Records */}
          <IonCard className="attendance-table-card">
            <IonCardHeader>
              <IonCardTitle className="table-title">
                <IonIcon icon={peopleOutline} />
                Today's Attendance
                <IonBadge color="primary">{attendanceRecords.length}</IonBadge>
              </IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              {loading ? (
                <div className="loading-state">
                  <IonSpinner name="circular" />
                  <p>Loading attendance records...</p>
                </div>
              ) : attendanceRecords.length === 0 ? (
                <div className="empty-state">
                  <IonIcon icon={peopleOutline} />
                  <h3>No Check-ins Yet</h3>
                  <p>Members who check in today will appear here</p>
                </div>
              ) : (
                <>
                  {/* Desktop/tablet view */}
                  <div className="attendance-table-wrap">
                    <div className="table-container">
                      <table className="attendance-table">
                        <thead>
                          <tr>
                            <th>Member</th>
                            <th>Username</th>
                            <th>Check-in</th>
                            <th>Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {attendanceRecords.map((record) => (
                            <tr key={record.id}>
                              <td>
                                <div className="member-name">
                                  <div className="member-avatar">
                                    {record.fullName.charAt(0).toUpperCase()}
                                  </div>
                                  <span>{record.fullName}</span>
                                </div>
                              </td>
                              <td>
                                <span className="email">{record.email}</span>
                              </td>
                              <td>
                                <div className="time-cell">
                                  <IonIcon icon={timeOutline} />
                                  <span>{record.checkInTime ? formatLocalTime(record.checkInTime) : ''}</span>
                                </div>
                              </td>
                              <td>
                                <div className="location-cell">
                                  <IonIcon icon={calendarOutline} />
                                  <span>{record.checkInTime ? formatLocalDate(record.checkInTime) : ""}</span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Mobile view (no horizontal scroll) */}
                  <div className="attendance-list-wrap">
                    <IonGrid>
                      <IonRow>
                        {attendanceRecords.map((record) => (
                          <IonCol key={record.id} size="12">
                            <IonCard className="attendance-item-card">
                              <IonCardContent>
                                <div className="member-name">
                                  <div className="member-avatar">
                                    {record.fullName.charAt(0).toUpperCase()}
                                  </div>
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, color: '#fff' }}>{record.fullName}</div>
                                    <div className="email">{record.email}</div>
                                  </div>
                                </div>

                                <div className="attendance-details" style={{ marginTop: 12 }}>
                                  <div className="detail-item">
                                    <IonIcon icon={timeOutline} />
                                    <span>{record.checkInTime ? formatLocalTime(record.checkInTime) : ''}</span>
                                  </div>
                                  <div className="detail-item">
                                    <IonIcon icon={calendarOutline} />
                                    <span>{record.checkInTime ? formatLocalDate(record.checkInTime) : ""}</span>
                                  </div>
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
            </IonCardContent>
          </IonCard>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default AdminAttendance;