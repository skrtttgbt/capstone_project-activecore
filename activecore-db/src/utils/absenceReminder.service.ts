import { pool } from '../config/db.config';
import { sendAbsenceReminderEmail } from './brevo.service';
import { logInfo, logError } from './logger';
import OpenAI from 'openai';

interface AbsentUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  lastAttendanceDate: string | null;
  daysSinceLastAttendance: number;
}

// Initialize OpenAI
let openai: OpenAI | undefined;
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Get all absent users (users with attendance gap > threshold)
 */
export const getAbsentUsers = async (thresholdDays: number = 3): Promise<AbsentUser[]> => {
  try {
    const [rows] = await pool.query<any>(
      `SELECT
         u.id,
         u.email,
         u.first_name AS firstName,
         u.last_name AS lastName,
         DATE(MAX(a.check_in_time)) AS lastAttendanceDate,
         u.created_at
       FROM users u
       LEFT JOIN attendance a ON u.id = a.user_id
       WHERE u.role = 'member'
       GROUP BY u.id, u.email, u.first_name, u.last_name, u.created_at
       ORDER BY u.created_at DESC`
    );

    // Trigger immediately for members who have never checked in, otherwise activate after the configured threshold.
    const absentUsers = rows
      .map((row: any) => {
        const hasNoAttendance = !row.lastAttendanceDate;
        const lastDate = row.lastAttendanceDate ? new Date(row.lastAttendanceDate) : new Date(row.created_at);
        const today = new Date();
        const daysSince = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

        return {
          ...row,
          daysSinceLastAttendance: daysSince,
          shouldSendReminder: hasNoAttendance || daysSince >= thresholdDays,
        };
      })
      .filter((user: any) => user.shouldSendReminder)
      .sort((a: any, b: any) => b.daysSinceLastAttendance - a.daysSinceLastAttendance);

    return absentUsers as AbsentUser[];
  } catch (error) {
    logError('Error fetching absent users:', error);
    return [];
  }
};

/**
 * Generate encouraging message using OpenAI
 */
export const generateEncouragingMessage = async (
  userName: string,
  daysAbsent: number
): Promise<string> => {
  if (!openai) {
    logError('OpenAI API not configured', new Error('Missing OPENAI_API_KEY'));
    return getDefaultEncouragingMessage(userName, daysAbsent);
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a friendly gym coach writing a brief, encouraging message to a member who has been absent from the gym.',
        },
        {
          role: 'user',
          content: `Write a short, encouraging message (2-3 sentences) for ${userName} who has been absent from the gym for ${daysAbsent} days. Be motivating but not pushy. Make it personal and friendly.`,
        },
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    const message = response.choices[0]?.message?.content || '';
    return message.trim();
  } catch (error) {
    logError('Error generating message via OpenAI:', error);
    return getDefaultEncouragingMessage(userName, daysAbsent);
  }
};

/**
 * Fallback encouraging message
 */
const getDefaultEncouragingMessage = (userName: string, daysAbsent: number): string => {
  const messages = [
    `${userName}, we miss you at the gym! It's been ${daysAbsent} days since your last visit. Remember, consistency is key to reaching your fitness goals. Come join us soon!`,
    `Hey ${userName}! Your fitness journey is important to us. It's time to get back on track! We're ready to support you on your next visit.`,
    `${userName}, your health matters! It's been ${daysAbsent} days since you were here. Let's get you back to your workout routine and crush those goals!`,
    `Keep up the momentum, ${userName}! While you've been away for ${daysAbsent} days, we believe in your commitment to fitness. See you soon!`,
  ];

  return messages[Math.floor(Math.random() * messages.length)];
};

/**
 * Send absence reminders to all absent users
 */
export const sendAbsenceReminders = async (thresholdDays: number = 3): Promise<{
  total: number;
  sent: number;
  failed: number;
}> => {
  const stats = { total: 0, sent: 0, failed: 0 };

  try {
    const absentUsers = await getAbsentUsers(thresholdDays);
    stats.total = absentUsers.length;

    if (stats.total === 0) {
      logInfo('No absent users found for reminders');
      return stats;
    }

    logInfo(`Found ${stats.total} absent users. Generating and sending reminders...`);

    for (const user of absentUsers) {
      try {
        const encouragingMessage = await generateEncouragingMessage(
          user.firstName || 'Member',
          user.daysSinceLastAttendance
        );

        const lastAttendanceDateStr = user.lastAttendanceDate
          ? new Date(user.lastAttendanceDate).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : 'never';

        const success = await sendAbsenceReminderEmail(
          user.email,
          user.firstName || 'Member',
          lastAttendanceDateStr,
          encouragingMessage
        );

        if (success) {
          stats.sent++;
          logInfo(`Absence reminder sent to ${user.email}`);
        } else {
          stats.failed++;
          logError(`Failed to send absence reminder to ${user.email}`, new Error('Brevo send failed'));
        }
      } catch (error) {
        stats.failed++;
        logError(`Error processing absence reminder for user ${user.id}:`, error);
      }
    }

    logInfo(`Absence reminder campaign completed. Sent: ${stats.sent}/${stats.total}`);
  } catch (error) {
    logError('Error in sendAbsenceReminders:', error);
  }

  return stats;
};
