import React, { useState, useEffect, useCallback } from 'react';
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonButton,
  IonIcon,
  IonBadge,
  IonButtons,
  IonMenuButton,
  IonAlert,
  useIonToast,
} from '@ionic/react';
import {
  checkmarkCircle,
  closeCircle,
  cash,
  person,
} from 'ionicons/icons';
import './AdminPendingPayments.css';

import { API_CONFIG } from '../config/api.config';

interface PendingPayment {
  id: number;
  user_id: number;
  firstName: string;
  lastName: string;
  email: string;
  amount: number;
  payment_method: string;
  membership_type: string;
  payment_status: string;
  transaction_id: string;
  payment_date: string;
}

const AdminPendingPayments: React.FC = () => {
  const [payments, setPayments] = useState<PendingPayment[]>([]);
  const [loadError, setLoadError] = useState('');
  const [showRejectAlert, setShowRejectAlert] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<PendingPayment | null>(null);
  const [presentToast] = useIonToast();

  const API_URL = API_CONFIG.BASE_URL;

  const getMemberName = (payment: PendingPayment): string => {
    const row = payment as any;
    const first = String(row.firstName ?? row.firstname ?? '').trim();
    const last = String(row.lastName ?? row.lastname ?? '').trim();
    return `${first} ${last}`.trim() || 'Member';
  };

  const loadPendingPayments = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/admin/payments/pending`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setPayments(data);
        setLoadError('');
      } else {
        let message = 'Failed to load pending payments';
        try {
          const err = await response.json();
          message = err?.message || message;
        } catch {
          // keep default message
        }
        setLoadError(message);
      }
    } catch (error) {
      console.error('Error loading pending payments:', error);
      setLoadError('Unable to reach server. Please check backend connection and try again.');
    }
  }, [API_URL]);

  useEffect(() => {
    loadPendingPayments();
    const interval = setInterval(loadPendingPayments, 30000);
    return () => clearInterval(interval);
  }, [loadPendingPayments]);

  const handleApprove = async (payment: PendingPayment) => {
    try {
      const response = await fetch(`${API_URL}/admin/payments/${payment.id}/approve`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      });

      if (response.ok) {
        const result = await response.json();
        
        presentToast({
          message: `✅ Payment approved for ${getMemberName(payment)}!\nSubscription: ${result.subscription.start} to ${result.subscription.end}`,
          duration: 5000,
          color: 'success',
          position: 'top'
        });
        
        await loadPendingPayments();
      } else {
        const error = await response.json();
        presentToast({
          message: `❌ ${error.message || 'Failed to approve payment'}`,
          duration: 3000,
          color: 'danger',
        });
      }
    } catch (error) {
      console.error('Error approving payment:', error);
      presentToast({
        message: '❌ Failed to approve payment',
        duration: 3000,
        color: 'danger',
      });
    }
  };

  const handleReject = async (reason: string) => {
    if (!selectedPayment) return;

    try {
      const response = await fetch(`${API_URL}/admin/payments/${selectedPayment.id}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ reason }),
      });

      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        presentToast({
          message: result?.message || 'Payment rejected',
          duration: 3000,
          color: 'warning',
        });
        setShowRejectAlert(false);
        setSelectedPayment(null);
        setPayments((current) => current.filter((payment) => payment.id !== selectedPayment.id));
        await loadPendingPayments();
      } else {
        let message = 'Failed to reject payment';
        try {
          const errorData = await response.json();
          message = errorData?.message || message;
        } catch {
          // keep default message
        }

        presentToast({
          message: `❌ ${message}`,
          duration: 3000,
          color: 'danger',
        });
      }
    } catch (error) {
      console.error('Error rejecting payment:', error);
      presentToast({
        message: '❌ Failed to reject payment',
        duration: 3000,
        color: 'danger',
      });
    }
  };

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonButtons slot="start">
            <IonMenuButton />
          </IonButtons>
          <IonTitle>Pending Payments</IonTitle>
          <IonBadge color="warning" style={{marginRight: '1rem'}}>
            {payments.length}
          </IonBadge>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding">
        <div className="pending-payments-container">
          {loadError ? (
            <div className="no-payments">
              <IonIcon icon={closeCircle} />
              <h3>Could Not Load Pending Payments</h3>
              <p>{loadError}</p>
              <IonButton onClick={loadPendingPayments} fill="outline" color="medium">
                Retry
              </IonButton>
            </div>
          ) : payments.length === 0 ? (
            <div className="no-payments">
              <IonIcon icon={checkmarkCircle} />
              <h3>No Pending Payments</h3>
              <p>All payments have been processed</p>
            </div>
          ) : (
            payments.map((payment) => (
              <IonCard key={payment.id} className="payment-card">
                <IonCardHeader>
                  <div className="payment-header">
                    <div>
                      <IonCardTitle>
                        <IonIcon icon={person} /> {getMemberName(payment)}
                      </IonCardTitle>
                      <p className="payment-email">{payment.email}</p>
                    </div>
                    <IonBadge color="warning">
                      {payment.payment_status.toUpperCase().replace('_', ' ')}
                    </IonBadge>
                  </div>
                </IonCardHeader>

                <IonCardContent>
                  <div className="payment-details">
                    <div className="detail-row">
                      <span>Amount:</span>
                      <strong>₱{payment.amount.toLocaleString()}</strong>
                    </div>
                    <div className="detail-row">
                      <span>Plan:</span>
                      <strong>{payment.membership_type.toUpperCase()}</strong>
                    </div>
                    <div className="detail-row">
                      <span>Method:</span>
                      <IonBadge color="medium">
                        <IonIcon icon={cash} />
                        {payment.payment_method.toUpperCase()}
                      </IonBadge>
                    </div>
                    <div className="detail-row">
                      <span>Date:</span>
                      <span>{new Date(payment.payment_date).toLocaleString()}</span>
                    </div>
                  </div>

                  <div className="action-buttons">
                    <IonButton
                      expand="block"
                      color="success"
                      onClick={() => handleApprove(payment)}
                    >
                      <IonIcon icon={checkmarkCircle} slot="start" />
                      Approve Payment
                    </IonButton>
                    <IonButton
                      expand="block"
                      color="danger"
                      fill="outline"
                      onClick={() => {
                        setSelectedPayment(payment);
                        setShowRejectAlert(true);
                      }}
                    >
                      <IonIcon icon={closeCircle} slot="start" />
                      Reject
                    </IonButton>
                  </div>
                </IonCardContent>
              </IonCard>
            ))
          )}
        </div>

        <IonAlert
          isOpen={showRejectAlert}
          onDidDismiss={() => {
            setShowRejectAlert(false);
            setSelectedPayment(null);
          }}
          header="Reject Payment"
          message="Please provide a reason for rejection"
          inputs={[
            {
              name: 'reason',
              type: 'textarea',
              placeholder: 'Enter reason...',
            },
          ]}
          buttons={[
            {
              text: 'Cancel',
              role: 'cancel',
            },
            {
              text: 'Reject',
              role: 'destructive',
              handler: (data) => {
                handleReject(data.reason || 'No reason provided');
              },
            },
          ]}
        />
      </IonContent>
    </IonPage>
  );
};

export default AdminPendingPayments;