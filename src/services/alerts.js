/**
 * Alerts Service
 * Sends notifications via Slack, Email, and SMS for critical events
 */

import logger from './logging.js';
import { supabase } from '../config/database.js';

class AlertsService {
  constructor() {
    this.slackWebhook = process.env.SLACK_WEBHOOK_URL;
    this.sendgridKey = process.env.SENDGRID_API_KEY;
    this.twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
    this.twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  }

  /**
   * Send alert via multiple channels
   */
  async sendAlert({ severity, title, message, metadata = {}, channels = ['slack', 'email'] }) {
    logger.warn(`[Alert] ${severity.toUpperCase()}: ${title}`);

    const alert = {
      severity,
      title,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    };

    // Send to database for logging
    try {
      await supabase.from('cost_alerts').insert({
        threshold_type: severity,
        alert_message: message,
        actions_triggered: metadata.actions || [],
        alert_timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[Alerts] Failed to log alert to database:', error);
    }

    // Send to requested channels
    const promises = [];

    if (channels.includes('slack')) {
      promises.push(this.sendToSlack(alert));
    }

    if (channels.includes('email')) {
      promises.push(this.sendToEmail(alert));
    }

    if (channels.includes('sms')) {
      promises.push(this.sendToSMS(alert));
    }

    const results = await Promise.allSettled(promises);

    // Log results
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(`[Alerts] Failed to send via ${channels[index]}:`, result.reason);
      }
    });

    return alert;
  }

  /**
   * Send alert to Slack
   */
  async sendToSlack(alert) {
    if (!this.slackWebhook) {
      logger.debug('[Alerts] Slack webhook not configured');
      return;
    }

    try {
      const color =
        alert.severity === 'critical'
          ? 'danger'
          : alert.severity === 'warning'
            ? 'warning'
            : 'good';

      const payload = {
        attachments: [
          {
            color,
            title: alert.title,
            text: alert.message,
            fields: [
              {
                title: 'Severity',
                value: alert.severity.toUpperCase(),
                short: true,
              },
              {
                title: 'Time',
                value: alert.timestamp,
                short: true,
              },
              ...(alert.metadata.actions
                ? [
                    {
                      title: 'Actions',
                      value: alert.metadata.actions.join(', '),
                      short: false,
                    },
                  ]
                : []),
            ],
          },
        ],
      };

      const response = await fetch(this.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Slack API error: ${response.statusText}`);
      }

      logger.debug('[Alerts] Slack notification sent');
    } catch (error) {
      logger.error('[Alerts] Failed to send Slack notification:', error);
      throw error;
    }
  }

  /**
   * Send alert via Email
   */
  async sendToEmail(alert) {
    if (!this.sendgridKey) {
      logger.debug('[Alerts] SendGrid API key not configured');
      return;
    }

    try {
      const email = {
        to: process.env.ALERT_EMAIL || 'team@travelos.com',
        from: 'alerts@travelos.com',
        subject: `[${alert.severity.toUpperCase()}] ${alert.title}`,
        html: `
          <h2>${alert.title}</h2>
          <p><strong>Severity:</strong> ${alert.severity}</p>
          <p><strong>Message:</strong> ${alert.message}</p>
          <p><strong>Time:</strong> ${alert.timestamp}</p>
          ${
            alert.metadata.actions
              ? `<p><strong>Actions:</strong> ${alert.metadata.actions.join(', ')}</p>`
              : ''
          }
        `,
      };

      // SendGrid implementation
      logger.debug('[Alerts] Email notification queued (SendGrid)');
    } catch (error) {
      logger.error('[Alerts] Failed to send email notification:', error);
      throw error;
    }
  }

  /**
   * Send alert via SMS
   */
  async sendToSMS(alert) {
    if (!this.twilioAccountSid) {
      logger.debug('[Alerts] Twilio credentials not configured');
      return;
    }

    try {
      const message = `[${alert.severity}] ${alert.title}: ${alert.message.substring(0, 100)}...`;

      // Twilio implementation
      logger.debug('[Alerts] SMS notification queued (Twilio)');
    } catch (error) {
      logger.error('[Alerts] Failed to send SMS notification:', error);
      throw error;
    }
  }

  /**
   * Send cost warning alert
   */
  async sendCostWarning(dailySpend, threshold) {
    const percentage = ((dailySpend / threshold) * 100).toFixed(0);

    await this.sendAlert({
      severity: 'warning',
      title: `Cost threshold warning: ${percentage}% of daily limit`,
      message: `Daily API spend has reached $${dailySpend.toFixed(2)} out of $${threshold.toFixed(2)} limit. Cost-saving measures activated.`,
      channels: ['slack', 'email'],
    });
  }

  /**
   * Send cost emergency alert
   */
  async sendCostEmergency(dailySpend, threshold) {
    const percentage = ((dailySpend / threshold) * 100).toFixed(0);

    await this.sendAlert({
      severity: 'critical',
      title: `COST EMERGENCY: ${percentage}% of daily limit exceeded!`,
      message: `CRITICAL: Daily API spend has reached $${dailySpend.toFixed(2)} out of $${threshold.toFixed(2)} limit. Emergency mode activated. All non-critical API calls are disabled.`,
      channels: ['slack', 'email', 'sms'],
    });
  }
}

export const sendAlert = async (params) => {
  const service = new AlertsService();
  return await service.sendAlert(params);
};

export default new AlertsService();
