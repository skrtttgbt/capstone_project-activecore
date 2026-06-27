// src/pages/Home.tsx
import { useState } from 'react';
import {
  IonContent,
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButton,
  IonIcon,
  IonLoading,
  IonModal,
  IonItem,
  IonLabel,
  IonInput,
  IonSpinner,
  IonButtons,
  IonGrid,
  IonRow,
  IonCol,
  IonCard,
  IonCardContent,
  useIonRouter
} from '@ionic/react';
import { logIn, informationCircle, peopleCircleOutline, qrCodeOutline, barChartOutline, nutritionOutline } from 'ionicons/icons';
import { loginUser } from '../services/auth.service';
import './Home.css';

const Home: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showLogin, setShowLogin] = useState(false);
  const [showLearnMore, setShowLearnMore] = useState(false);
  const [error, setError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginMessage, setLoginMessage] = useState('Logging in…');
  const router = useIonRouter();

  const handleLogin = async () => {
    if (isLoggingIn) return;

    const submittedUsername = username.trim();
    const submittedPassword = password;

    if (!submittedUsername || !submittedPassword) {
      setError('Username and password are required');
      return;
    }

    let slowTimer: number | undefined;

    try {
      setError('');
      setIsLoggingIn(true);
      setLoginMessage('Logging in…');

      slowTimer = window.setTimeout(() => {
        setLoginMessage('Logging in… (this can take a moment)');
      }, 5000);

      const result = await loginUser(submittedUsername, submittedPassword);
      if (result.user.role === 'admin') {
        router.push('/admin', 'root', 'replace');
      } else {
        router.push('/member', 'root', 'replace');
      }
      setShowLogin(false);
    } catch (error: any) {
      setError(error.message);
      console.error('Login error:', error);
    } finally {
      if (slowTimer !== undefined) {
        window.clearTimeout(slowTimer);
      }
      setIsLoggingIn(false);
    }
  };

  const handleLoginSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handleLogin();
  };


  return (
    <IonPage className="home-page">
      <IonHeader>
        <IonToolbar>
          <IonTitle>🏋️ ActiveCore</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent fullscreen>
        <div className="hero-section">
          <IonGrid fixed>
            <IonRow>
              <IonCol size="12">
                <h1>Welcome to ActiveCore</h1>
                <p>
                  <strong>ActiveCore</strong> is an internal gym management system built for one fitness facility. The platform prioritizes AI-assisted meal planning while also supporting attendance, subscriptions, and daily gym operations.
                </p>
              </IonCol>
            </IonRow>

            <IonRow className="ion-justify-content-center ion-align-items-center">
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonButton
                  className="secondary-button"
                  fill="outline"
                  size="large"
                  expand="block"
                  onClick={() => setShowLearnMore(true)}
                >
                  <IonIcon icon={informationCircle} slot="start" />
                  System Overview
                </IonButton>
              </IonCol>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonButton
                  className="login-button"
                  fill="clear"
                  expand="block"
                  onClick={() => setShowLogin(true)}
                >
                  <IonIcon icon={logIn} slot="start" />
                  Log In
                </IonButton>
              </IonCol>
            </IonRow>
          </IonGrid>
        </div>

        <section className="stats-section">
          <IonGrid fixed>
            <IonRow>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonCard className="stat-card">
                  <IonCardContent>
                    <h2>AI Meal Planner</h2>
                    <p>Nutritional Support</p>
                    <span>Main feature for personalized meal guidance</span>
                  </IonCardContent>
                </IonCard>
              </IonCol>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonCard className="stat-card">
                  <IonCardContent>
                    <h2>QR Attendance</h2>
                    <p>Daily Check-ins</p>
                    <span>Faster front-desk validation</span>
                  </IonCardContent>
                </IonCard>
              </IonCol>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonCard className="stat-card">
                  <IonCardContent>
                    <h2>Billing Workflow</h2>
                    <p>Payments & Renewals</p>
                    <span>Track pending and approved entries</span>
                  </IonCardContent>
                </IonCard>
              </IonCol>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonCard className="stat-card">
                  <IonCardContent>
                    <h2>1 Gym</h2>
                    <p>Single-Facility Focus</p>
                    <span>Built for your daily operations</span>
                  </IonCardContent>
                </IonCard>
              </IonCol>
            </IonRow>
          </IonGrid>
        </section>

        <section className="features-section">
          <IonGrid fixed>
            <IonRow>
              <IonCol size="12">
                <h2>Core Management Modules</h2>
              </IonCol>
            </IonRow>

            <IonRow>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonCard className="feature-card">
                  <IonCardContent>
                    <IonIcon icon={nutritionOutline} className="feature-symbol" />
                    <h3>AI Nutritional Meal Planner</h3>
                    <p>Generate diet-aware meal plans and regenerate meals based on goals, preferences, and restrictions.</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonCard className="feature-card">
                  <IonCardContent>
                    <IonIcon icon={peopleCircleOutline} className="feature-symbol" />
                    <h3>Member Profiles & Plans</h3>
                    <p>Maintain member details, subscription periods, and account status in one place.</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonCard className="feature-card">
                  <IonCardContent>
                    <IonIcon icon={qrCodeOutline} className="feature-symbol" />
                    <h3>QR Attendance Tracking</h3>
                    <p>Generate secure QR tokens and monitor daily member attendance instantly.</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>
              <IonCol size="12" sizeMd="6" sizeLg="3">
                <IonCard className="feature-card">
                  <IonCardContent>
                    <IonIcon icon={barChartOutline} className="feature-symbol" />
                    <h3>Payments, Approvals, and Reports</h3>
                    <p>Record payments, approve transactions, and review key gym operations in one dashboard.</p>
                  </IonCardContent>
                </IonCard>
              </IonCol>
            </IonRow>
          </IonGrid>
        </section>

        {/* Learn More Modal */}
        <IonModal isOpen={showLearnMore} onDidDismiss={() => setShowLearnMore(false)}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>About ActiveCore</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setShowLearnMore(false)}>Close</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            <h2 style={{ color: '#00e676', marginTop: '1rem' }}>What is ActiveCore?</h2>
            <p>
              <strong>ActiveCore</strong> is an internal management platform for a specific gym. It is designed for gym admins, staff, and registered members to handle daily operations efficiently.
            </p>
            <ul>
              <li>Deliver AI-powered nutritional support through the Meal Planner module</li>
              <li>Manage member accounts, plans, and subscription dates</li>
              <li>Track attendance using secure QR check-ins</li>
              <li>Handle payment renewals and admin approval workflows</li>
              <li>Provide member tools like meal planning and progress tracking</li>
              <li>View operational reports for attendance and payments</li>
            </ul>
            <p>
              This project is not a public gym marketplace. It is built to support the day-to-day management needs of one gym business.
            </p>
          </IonContent>
        </IonModal>

        {/* Login Modal */}
        <IonModal isOpen={showLogin} onDidDismiss={() => setShowLogin(false)}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>Login</IonTitle>
              <IonButtons slot="end">
                <IonButton disabled={isLoggingIn} onClick={() => setShowLogin(false)}>Close</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            <IonLoading
              isOpen={isLoggingIn}
              message={loginMessage}
              backdropDismiss={false}
            />
            <form className="login-form" onSubmit={handleLoginSubmit}>
              {error && (
                <IonItem color="danger" lines="none">
                  <IonLabel>{error}</IonLabel>
                </IonItem>
              )}
              <IonItem>
                <IonLabel position="stacked">Username</IonLabel>
                <IonInput
                  type="text"
                  value={username}
                  onIonInput={(e) => setUsername(String(e.detail.value ?? ''))}
                  placeholder="Enter your username"
                  disabled={isLoggingIn}
                />
              </IonItem>
              <IonItem>
                <IonLabel position="stacked">Password</IonLabel>
                <IonInput
                  type="password"
                  value={password}
                  onIonInput={(e) => setPassword(String(e.detail.value ?? ''))}
                  placeholder="Enter your password"
                  disabled={isLoggingIn}
                />
              </IonItem>
              <div className="ion-padding-top">
                <IonButton type="submit" expand="block" disabled={isLoggingIn}>
                  {isLoggingIn ? (
                    <>
                      <IonSpinner name="crescent" style={{ marginRight: 10 }} />
                      Logging in…
                    </>
                  ) : (
                    'Log In'
                  )}
                </IonButton>
              </div>
            </form>
          </IonContent>
        </IonModal>
      </IonContent>
    </IonPage>
  );
};

export default Home;