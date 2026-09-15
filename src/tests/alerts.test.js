/**
 * Alert Service Tests
 * Tests for Slack/Email alert dispatching
 */

import * as alertService from '../services/alert-service.js';

jest.mock('axios');

describe('Alert Service', () => {
  beforeEach(() => {
    alertService.clearAlerts();
    jest.clearAllMocks();
  });

  describe('Adding Alerts', () => {
    test('should add alert to in-memory storage', () => {
      const alert = {
        severity: 'CRITICAL',
        type: 'monthly_budget_exceeded',
        message: 'Budget exceeded'
      };

      alertService.addAlert(alert);
      const alerts = alertService.getAlerts();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('CRITICAL');
      expect(alerts[0].created_at).toBeDefined();
    });

    test('should add created_at timestamp', () => {
      const alert = {
        severity: 'WARNING',
        type: 'quota_warning',
        message: 'Approaching quota'
      };

      alertService.addAlert(alert);
      const alerts = alertService.getAlerts();

      expect(alerts[0].created_at).toBeDefined();
      expect(typeof alerts[0].created_at).toBe('string');
    });
  });

  describe('Alert Retrieval', () => {
    test('should get all alerts', () => {
      alertService.addAlert({ severity: 'CRITICAL', message: 'Alert 1' });
      alertService.addAlert({ severity: 'WARNING', message: 'Alert 2' });

      const alerts = alertService.getAlerts();
      expect(alerts).toHaveLength(2);
    });

    test('should clear all alerts', () => {
      alertService.addAlert({ severity: 'CRITICAL', message: 'Alert 1' });
      alertService.addAlert({ severity: 'WARNING', message: 'Alert 2' });

      alertService.clearAlerts();
      const alerts = alertService.getAlerts();

      expect(alerts).toHaveLength(0);
    });
  });

  describe('Slack Alert', () => {
    test('should send Slack alert without throwing', async () => {
      const alert = {
        severity: 'CRITICAL',
        type: 'monthly_budget_exceeded',
        message: 'Budget exceeded'
      };

      // Should not throw
      await alertService.sendSlackAlert(alert);
      expect(true).toBe(true);
    });

    test('should handle different severity levels', async () => {
      const severities = ['CRITICAL', 'WARNING', 'INFO'];

      for (const severity of severities) {
        const alert = {
          severity,
          type: 'test',
          message: `Test ${severity} alert`
        };

        await alertService.sendSlackAlert(alert);
      }

      expect(true).toBe(true);
    });
  });

  describe('Email Alert', () => {
    test('should send email alert without throwing', async () => {
      const alert = {
        severity: 'CRITICAL',
        type: 'monthly_budget_exceeded',
        message: 'Budget exceeded'
      };

      const recipients = ['admin@example.com'];
      await alertService.sendEmailAlert(alert, recipients);
      expect(true).toBe(true);
    });

    test('should send to multiple recipients', async () => {
      const alert = {
        severity: 'CRITICAL',
        message: 'Test alert'
      };

      const recipients = ['admin@example.com', 'ops@example.com'];
      await alertService.sendEmailAlert(alert, recipients);
      expect(true).toBe(true);
    });
  });

  describe('Process Alerts', () => {
    test('should process pending alerts', async () => {
      alertService.addAlert({
        severity: 'CRITICAL',
        type: 'monthly_budget_exceeded',
        message: 'Budget exceeded',
        sent: false
      });

      await alertService.processAlerts();

      const alerts = alertService.getAlerts();
      expect(alerts[0].sent).toBe(true);
    });

    test('should mark alert as sent after processing', async () => {
      alertService.addAlert({
        severity: 'WARNING',
        type: 'quota_warning',
        message: 'Approaching quota',
        sent: false
      });

      await alertService.processAlerts();

      const alerts = alertService.getAlerts();
      expect(alerts[0].sent).toBe(true);
      expect(alerts[0].sent_at).toBeDefined();
    });
  });

  describe('Daily Digest', () => {
    test('should send daily digest without throwing', async () => {
      alertService.addAlert({
        severity: 'CRITICAL',
        message: 'Test alert'
      });

      await alertService.sendDailyDigest();
      expect(true).toBe(true);
    });

    test('should not throw when no alerts exist', async () => {
      alertService.clearAlerts();
      await alertService.sendDailyDigest();
      expect(true).toBe(true);
    });
  });

  describe('Strict Mode', () => {
    test('should enforce strict mode after budget exceeded', async () => {
      alertService.addAlert({
        severity: 'CRITICAL',
        type: 'monthly_budget_exceeded',
        message: 'Budget exceeded'
      });

      const shouldEnforce = await alertService.shouldEnforceStrictMode();
      expect(typeof shouldEnforce).toBe('boolean');
      expect(shouldEnforce).toBe(true);
    });

    test('should not enforce strict mode without budget alert', async () => {
      alertService.clearAlerts();
      alertService.addAlert({
        severity: 'WARNING',
        type: 'quota_warning',
        message: 'Warning'
      });

      const shouldEnforce = await alertService.shouldEnforceStrictMode();
      expect(shouldEnforce).toBe(false);
    });

    test('should not enforce strict mode for old alerts', async () => {
      alertService.clearAlerts();

      // Add alert from 2 days ago
      const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const alerts = alertService.getAlerts();
      alerts.push({
        severity: 'CRITICAL',
        type: 'monthly_budget_exceeded',
        message: 'Old alert',
        created_at: oldDate.toISOString()
      });

      const shouldEnforce = await alertService.shouldEnforceStrictMode();
      expect(shouldEnforce).toBe(false);
    });
  });
});
