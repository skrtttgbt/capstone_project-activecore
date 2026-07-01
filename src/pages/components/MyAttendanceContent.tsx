import React, { useEffect, useState } from 'react';
import '../MyAttendance.css';
import { API_CONFIG } from '../../config/api.config';
import { formatLocalDate, formatLocalTime } from '../../utils/dateTime';

const API_URL = API_CONFIG.BASE_URL;

type AttendanceRecord = {
  id: number;
  checkInTime: string;
  location: string;
  status: string;
};

const MyAttendanceContent: React.FC = () => {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [legacyAttendanceDays, setLegacyAttendanceDays] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadLegacy = () => {
      const currentUser = localStorage.getItem('currentUser') || 'demo_member';
      const data = JSON.parse(localStorage.getItem('attendance') || '{}');
      if (data[currentUser] && Array.isArray(data[currentUser].attendance)) {
        setLegacyAttendanceDays(data[currentUser].attendance);
      }
    };

    const loadFromApi = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        loadLegacy();
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`${API_URL}/attendance/history`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          loadLegacy();
          return;
        }

        const data = await response.json();
        if (data?.success && Array.isArray(data.attendance)) {
          setRecords(data.attendance);
        } else {
          loadLegacy();
        }
      } catch {
        loadLegacy();
      } finally {
        setLoading(false);
      }
    };

    loadFromApi();
  }, []);

  return (
    <div style={{ padding: '2rem' }}>
      <h2 className="attendance-title">My Attendance History</h2>
      <ul className="attendance-list">
        {loading ? (
          <li>Loading...</li>
        ) : records.length > 0 ? (
          records.map((r) => (
            <li key={r.id}>
              📅 {formatLocalDate(r.checkInTime)} · {formatLocalTime(r.checkInTime)}
            </li>
          ))
        ) : legacyAttendanceDays.length > 0 ? (
          legacyAttendanceDays.map((day, index) => (
            <li key={index}>✅ {day}</li>
          ))
        ) : (
          <li>No attendance records yet.</li>
        )}
      </ul>
    </div>
  );
};

export default MyAttendanceContent;