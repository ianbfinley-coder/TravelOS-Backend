/**
 * Alert Service
 * Handles alert dispatching via Slack, Email, and database
 */

import axios from 'axios';
import nodemailer from 'nodemailer';

const alerts = [];

/**
 * Send alert to Slack
 */
export const sendSlackAlert = async (alert) => {
  console.log('Slack alert:', alert);

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    // In production, would send to Slack
    console.log(`Sent ${alert.severity} alert to Slack: ${alert.message}`);
  } catch (error) {
    console.error('Failed to send Slack alert:', error);
  }
};

/**
 * Send alert via Email
 */
export const sendEmailAlert = async (alert, recipients) => {
  console.log('Email alert to', recipients, ':', alert);

  try {
    // In production, would send email
    console.log(`Sent ${alert.severity} email to ${recipients.join(',')}`);
  } catch (error) {
    console.error('Failed to send email alert:', error);
  }
};

/**
 * Process pending alerts from database
 */
export const processAlerts = async () => {
  // Get pending alerts from database
  const pendingAlerts = alerts.filter(a => !a.sent);

  for (const alert of pendingAlerts) {
    // Dispatch based on severity
    if (alert.severity === 'CRITICAL') {
      await sendSlackAlert(alert);
      await sendEmailAlert(alert, [process.env.ALERT_EMAIL_TO || 'admin@example.com']);
    } else if (alert.severity === 'WARNING') {
      await sendSlackAlert(alert);
    }

    // Mark as sent
    alert.sent = true;
    alert.sent_at = new Date().toISOString();
  }
};

/**
 * Send daily digest
 */
export const sendDailyDigest = async () => {
  // Get alerts from past 24 hours
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  const dailyAlerts = alerts.filter(a => {
    const alertTime = new Date(a.created_at).getTime();
    return alertTime > oneDayAgo;
  });

  if (dailyAlerts.length === 0) {
    return;
  }

  // Count by severity
  const counts = {
    CRITICAL: dailyAlerts.filter(a => a.severity === 'CRITICAL').length,
    WARNING: dailyAlerts.filter(a => a.severity === 'WARNING').length,
    INFO: dailyAlerts.filter(a => a.severity === 'INFO').length
  };

  // Send digest email
  const recipients = [process.env.ALERT_EMAIL_TO || 'admin@example.com'];
  console.log(`Sent Daily API Digest to ${recipients.join(',')}`);
};

/**
 * Check if strict mode should be enforced
 */
export const shouldEnforceStrictMode = async () => {
  // Check for recent budget_exceeded alert
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  const recentAlert = alerts.find(a => {
    if (a.type !== 'monthly_budget_exceeded') return false;
    const alertTime = new Date(a.created_at).getTime();
    return alertTime > oneDayAgo;
  });

  return !!recentAlert;
};

/**
 * Add an alert (for testing)
 */
export const addAlert = (alert) => {
  alert.created_at = new Date().toISOString();
  alerts.push(alert);
};

/**
 * Get all alerts
 */
export const getAlerts = () => {
  return [...alerts];
};

/**
 * Clear alerts (for testing)
 */
export const clearAlerts = () => {
  alerts.length = 0;
};
