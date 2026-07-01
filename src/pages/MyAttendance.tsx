import React, { useEffect, useState } from "react";
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonMenuButton,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonBadge,
  IonButton,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonGrid,
  IonRow,
  IonCol,
  IonProgressBar,
  IonList, // ✅ Add this
} from "@ionic/react";
import {
  checkmarkCircle,
  trophy,
  calendar,
  timeOutline,
  gift,
  calendarOutline,
  flame,
} from "ionicons/icons";
import "./MyAttendance.css";

import { API_CONFIG } from "../config/api.config";
import { formatLocalDate, formatLocalTime } from '../utils/dateTime';

const API_URL = API_CONFIG.BASE_URL;

interface AttendanceRecord {
  id: number;
  checkInTime: string;
  location: string;
  status: string;
  date?: string;
  time?: string;
}

interface Reward {
  id: number;
  title: string;
  description: string;
  requiredAttendance: number;
  points: number;
  category: string;
  icon: string;
  claimed: boolean;
  claimedAt?: string;
}

interface Stats {
  totalAttendance: number;
  currentStreak: number;
}

const MyAttendance: React.FC = () => {
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [stats, setStats] = useState<Stats>({ totalAttendance: 0, currentStreak: 0 });
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("Member");
  const [firstName, setFirstName] = useState("M");

  useEffect(() => {
    loadUserData();
    loadAttendanceData();
    loadRewards();
  }, []);

  const loadUserData = async () => {
    try {
      // Try to get user from API first
      const token = localStorage.getItem('token');
      if (token) {
        const response = await fetch(`${API_URL}/user/profile`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data.success && data.user) {
            const fullName = `${data.user.firstName || ''} ${data.user.lastName || ''}`.trim();
            setUserName(fullName || data.user.username || data.user.email || "Member");
            setFirstName(data.user.firstName || "M");
            console.log('👤 User loaded from API:', fullName);
            return;
          }
        }
      }

      // Fallback to localStorage
      const userStr = localStorage.getItem("currentUser") || localStorage.getItem("user");
      if (userStr) {
        const user = JSON.parse(userStr);
        const fullName = `${user.firstName || user.first_name || ''} ${user.lastName || user.last_name || ''}`.trim();
        setUserName(fullName || user.username || user.email || "Member");
        setFirstName(user.firstName || user.first_name || "M");
        console.log('👤 User loaded from localStorage:', fullName);
      }
    } catch (err) {
      console.error("Error loading user data:", err);
      setUserName("Member");
      setFirstName("M");
    }
  };

  const loadAttendanceData = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      
      if (!token) {
        console.error('No auth token found');
        return;
      }

      console.log('📊 Loading attendance data...');

      const response = await fetch(`${API_URL}/attendance/history`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch attendance');
      }

      const data = await response.json();
      
      if (data.success) {
        setAttendanceRecords(data.attendance);
        setStats(data.stats);
        console.log('✅ Loaded attendance:', data.attendance.length, 'records');
        console.log('📊 Stats:', data.stats);
      }
    } catch (error) {
      console.error('❌ Error loading attendance:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadRewards = async () => {
    try {
      const token = localStorage.getItem('token');
      
      if (!token) {
        return;
      }

      console.log('🎁 Loading rewards...');

      const response = await fetch(`${API_URL}/rewards/available`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch rewards');
      }

      const data = await response.json();
      
      if (data.success) {
        setRewards(data.rewards);
        console.log('✅ Loaded rewards:', data.rewards.length);
      }
    } catch (error) {
      console.error('❌ Error loading rewards:', error);
    }
  };

  const handleClaimReward = async (rewardId: number) => {
    try {
      const token = localStorage.getItem('token');
      
      const response = await fetch(`${API_URL}/rewards/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ rewardId }),
      });

      const data = await response.json();
      
      if (data.success) {
        alert(`🎉 ${data.message}`);
        loadRewards(); // Reload rewards to update claimed status
      } else {
        alert(`❌ ${data.message}`);
      }
    } catch (error) {
      console.error('❌ Error claiming reward:', error);
      alert('Failed to claim reward. Please try again.');
    }
  };

  const handleRefresh = async (event: CustomEvent) => {
    await loadAttendanceData();
    await loadRewards();
    event.detail.complete();
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>
          <IonTitle>My Attendance</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent className="my-attendance-content" fullscreen>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent></IonRefresherContent>
        </IonRefresher>

        <div className="attendance-wrapper">
          {/* User Header */}
          <div className="user-header">
            <div className="user-avatar">
              {firstName.charAt(0).toUpperCase()}
            </div>
            <div className="user-info">
              <h1>{userName}'s Progress 📊</h1>
              <p>Keep up the great work!</p>
            </div>
          </div>

          {/* Stats Grid */}
          <IonGrid className="stats-grid">
            <IonRow>
              <IonCol size="6">
                <IonCard className="stat-card">
                  <IonCardContent>
                    <IonIcon icon={calendar} className="stat-icon primary" />
                    <h2>{stats.totalAttendance}</h2>
                    <p>Total Check-ins</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>
              <IonCol size="6">
                <IonCard className="stat-card">
                  <IonCardContent>
                    <IonIcon icon={flame} className="stat-icon fire" />
                    <h2>{stats.currentStreak}</h2>
                    <p>Day Streak</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>
            </IonRow>
          </IonGrid>

          {/* Attendance History */}
          <IonCard className="history-card">
            <IonCardHeader>
              <IonCardTitle className="section-title">
                <IonIcon icon={checkmarkCircle} />
                Attendance History
                <IonBadge color="primary">{attendanceRecords.length}</IonBadge>
              </IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              {loading ? (
                <div className="loading-state">
                  <IonIcon icon={timeOutline} />
                  <p>Loading attendance...</p>
                </div>
              ) : attendanceRecords.length === 0 ? (
                <div className="empty-state">
                  <IonIcon icon={calendarOutline} />
                  <h3>No Attendance Records</h3>
                  <p>Your check-in history will appear here</p>
                </div>
              ) : (
                <IonList className="attendance-list">
                  {attendanceRecords.map((record) => (
                    <IonCard key={record.id} className="attendance-item">
                      <IonCardContent>
                        <div className="attendance-date">
                          <IonIcon icon={calendar} />
                          <span>{record.checkInTime ? formatLocalDate(record.checkInTime) : ''}</span>
                        </div>
                        <div className="attendance-details">
                          <div className="detail-item">
                            <IonIcon icon={timeOutline} />
                            <span>{record.checkInTime ? formatLocalTime(record.checkInTime) : ''}</span>
                          </div>
                          <div className="detail-item">
                            <IonIcon icon={calendarOutline} />
                            <span>{record.checkInTime ? formatLocalDate(record.checkInTime) : ''}</span>
                          </div>
                        </div>
                        <IonBadge color="success" className="status-badge">
                          {record.status}
                        </IonBadge>
                      </IonCardContent>
                    </IonCard>
                  ))}
                </IonList>
              )}
            </IonCardContent>
          </IonCard>

          {/* Rewards Section */}
          <IonCard className="rewards-card">
            <IonCardHeader>
              <IonCardTitle className="section-title">
                <IonIcon icon={trophy} />
                Available Rewards
              </IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              {rewards.length === 0 ? (
                <div className="empty-state">
                  <IonIcon icon={gift} />
                  <h3>No Rewards Yet</h3>
                  <p>Keep attending to unlock rewards!</p>
                </div>
              ) : (
                <IonGrid className="rewards-grid">
                  <IonRow>
                    {rewards.map((reward) => {
                      const canClaim = stats.totalAttendance >= reward.requiredAttendance && !reward.claimed;
                      const isLocked = stats.totalAttendance < reward.requiredAttendance;
                      const progress = reward.requiredAttendance
                        ? Math.min(stats.totalAttendance / reward.requiredAttendance, 1)
                        : 0;

                      return (
                        <IonCol key={reward.id} size="12" sizeMd="6" sizeLg="4">
                          <div
                            className={`reward-item ${
                              reward.claimed ? 'claimed' : canClaim ? 'unlocked' : 'locked'
                            }`}
                          >
                            <div className="reward-icon">{reward.icon}</div>
                            <div className="reward-info">
                              <h3>{reward.title}</h3>
                              <p>{reward.description}</p>
                              <div className="reward-requirement">
                                <IonBadge color={canClaim ? 'success' : 'medium'}>
                                  {stats.totalAttendance}/{reward.requiredAttendance} check-ins
                                </IonBadge>
                              </div>
                            </div>

                            {canClaim && !reward.claimed && (
                              <IonButton
                                expand="block"
                                className="claim-button"
                                onClick={() => handleClaimReward(reward.id)}
                              >
                                <IonIcon icon={gift} slot="start" />
                                Claim Reward
                              </IonButton>
                            )}

                            {reward.claimed && (
                              <IonBadge color="success">Claimed</IonBadge>
                            )}

                            {isLocked && (
                              <div className="reward-progress">
                                <IonProgressBar value={progress} />
                              </div>
                            )}
                          </div>
                        </IonCol>
                      );
                    })}
                  </IonRow>
                </IonGrid>
              )}
            </IonCardContent>
          </IonCard>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default MyAttendance;