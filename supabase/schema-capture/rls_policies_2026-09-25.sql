-- TravelOS - Row Level Security surface
-- Generated 2026-09-25 from the live database (project cyrgzvnjvevwbjqxgfxd).
-- Schemas covered: public, private.
--
-- WHY THIS FILE EXISTS
-- The schema had no on-disk representation at all: 152 migrations were
-- recorded in the remote migration history and zero existed as files.
-- `supabase db dump` needs Docker, which was not available, so this was
-- generated from the system catalogs instead.
--
-- WHAT IT IS
-- A capture of live state, NOT a migration to replay blindly. Table and
-- column definitions are not included - this is the security surface only.
-- Supersede it with a full `supabase db dump` once Docker is running.
--
-- It includes the two policy migrations applied 2026-09-25 17:12 UTC, which
-- replaced 15 SELECT policies whose USING expression was literally `true`
-- applying to PUBLIC - readable with the published anon key - with real
-- membership checks scoped to `authenticated`.

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_read_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agreement_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agreement_questionnaires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agreement_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.airline_loyalty_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_dedup_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_delivery_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_preferences_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_queue_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_rate_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alignment_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_cache_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_cost_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_cost_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_service_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.archived_generated_itineraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.availability_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ballots_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bargain_norms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.better_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_platforms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_notification_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_event_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_share_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_sync_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canary_test_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.circuit_breaker_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concurrency_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copilot_trip_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_friction_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.day_energy_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.day_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dedup_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dep_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dep_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dietary_phrase_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disaster_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dismissed_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disruption_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disruption_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disruption_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_message_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.embassies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_info ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entry_requirement_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entry_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eta_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_disruptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.happiness_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.happy_moments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hotel_loyalty_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hotel_loyalty_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hotel_oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hotel_token_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.important_information ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inapp_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itinerary_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itinerary_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loop_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_aggregator_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitored_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offline_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offline_trip_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pace_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_calibration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phrase_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_recovery_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.place_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planning_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbook_step_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_options_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.polls_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pre_trip_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pre_trip_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prediction_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prep_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_circuit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rating_prompt_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.readiness_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendation_engagement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendation_trending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.replan_applied ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.replan_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_poll_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rollcall_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rollcalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_advisories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.satisfaction_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.secure_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.serendipity_dismissed ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.serendipity_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.serendipity_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shareable_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slo_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taxonomy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tips_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.traffic_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.travel_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.travel_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.traveler_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_assemblies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_change_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_health_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_impacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_planning_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.typing_indicators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_alert_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_behavior_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_recommendation_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weather_forecasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY require_mfa_when_enrolled
  ON public.activity_events
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_write_activity
  ON public.activity_events
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY trip_members_read_activity
  ON public.activity_events
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY trip_members_read_completions
  ON public.agreement_completions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY service_role_write_completions
  ON public.agreement_completions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.agreement_completions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY trip_members_read_questionnaire
  ON public.agreement_questionnaires
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.agreement_questionnaires
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_write_questionnaire
  ON public.agreement_questionnaires
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.agreement_responses
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_all_responses
  ON public.agreement_responses
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Users manage own airline cache"
  ON public.airline_loyalty_cache
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.airline_loyalty_cache
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own batches"
  ON public.alert_batches
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.alert_batches
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users view own dedup log"
  ON public.alert_dedup_log
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.alert_dedup_log
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.alert_delivery_log
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users view own delivery log"
  ON public.alert_delivery_log
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can manage own preferences"
  ON public.alert_preferences
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.alert_preferences
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users view own queue stats"
  ON public.alert_queue_stats
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.alert_queue_stats
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users view own rate counters"
  ON public.alert_rate_counters
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.alert_rate_counters
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY trip_members_read_report
  ON public.alignment_reports
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY service_role_write_report
  ON public.alignment_reports
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.alignment_reports
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.api_cache_entries
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_only
  ON public.api_cache_entries
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY service_role_only
  ON public.api_cost_daily
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.api_cost_daily
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users view own snapshots"
  ON public.availability_snapshots
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.availability_snapshots
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.ballots_v2
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_all_ballots
  ON public.ballots_v2
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.bargain_norms
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "authenticated read"
  ON public.bargain_norms
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY "Users can manage their own better deals"
  ON public.better_deals
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.better_deals
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.booking_conflicts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own booking conflicts"
  ON public.booking_conflicts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY "Users view own conflicts"
  ON public.booking_conflicts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can manage their own booking connections"
  ON public.booking_connections
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.booking_connections
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.booking_platforms
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "authenticated read"
  ON public.booking_platforms
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY "Users can manage their own booking reservations"
  ON public.booking_reservations
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.booking_reservations
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_write
  ON public.budget_aggregates
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.budget_aggregates
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "trip members read"
  ON public.budget_aggregates
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (( SELECT private.is_trip_member(budget_aggregates.trip_id) AS is_trip_member));
CREATE POLICY require_mfa_when_enrolled
  ON public.budget_analyses
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own budget analyses"
  ON public.budget_analyses
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.budget_notification_queue
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_only_notif
  ON public.budget_notification_queue
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY service_role_only
  ON public.budget_preferences
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.budget_preferences
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.calendar_connections
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own calendar connections"
  ON public.calendar_connections
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.calendar_event_mappings
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own event mappings"
  ON public.calendar_event_mappings
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.calendar_invitations
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage invitations they sent"
  ON public.calendar_invitations
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING ((sent_by = auth.uid()));
CREATE POLICY "Anyone can view invitation by token"
  ON public.calendar_invitations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated, anon
  USING ((expires_at > now()));
CREATE POLICY "Users view own sync errors"
  ON public.calendar_sync_errors
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.calendar_sync_errors
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.calendar_sync_log
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users view own sync log"
  ON public.calendar_sync_log
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.change_proposals
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY trip_members_read_proposals
  ON public.change_proposals
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY service_role_write_proposals
  ON public.change_proposals
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Users manage own checkins"
  ON public.checkins
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((auth.uid())::text = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.checkins
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_write_comments
  ON public.comments
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.comments
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY trip_members_read_comments
  ON public.comments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY service_role_all
  ON public.concurrency_audit_log
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.copilot_drafts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_only_copilot_drafts
  ON public.copilot_drafts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY service_only_copilot_messages
  ON public.copilot_messages
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.copilot_messages
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY users_read_own_proposals
  ON public.copilot_proposals
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.copilot_proposals
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_only_copilot_settings
  ON public.copilot_settings
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.copilot_settings
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_only_copilot_threads
  ON public.copilot_threads
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.copilot_threads
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.copilot_trip_summaries
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_only_copilot_summaries
  ON public.copilot_trip_summaries
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY "authenticated read"
  ON public.cost_index
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.cost_index
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "currencies readable"
  ON public.currencies
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.currencies
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can insert their own friction scores"
  ON public.daily_friction_scores
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own friction scores"
  ON public.daily_friction_scores
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can update their own friction scores"
  ON public.daily_friction_scores
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.daily_friction_scores
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_only_day_energy
  ON public.day_energy_snapshots
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.day_energy_snapshots
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_write_snapshots
  ON public.day_snapshots
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY trip_members_read_snapshots
  ON public.day_snapshots
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.day_snapshots
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.delivery_attempts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users view own delivery attempts"
  ON public.delivery_attempts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.dietary_phrase_cards
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "authenticated read"
  ON public.dietary_phrase_cards
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.disaster_alerts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own disaster alerts"
  ON public.disaster_alerts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY "Users manage own dismissed alerts"
  ON public.dismissed_alerts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.dismissed_alerts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.document_imports
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own document imports"
  ON public.document_imports
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.email_attachments
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own attachments"
  ON public.email_attachments
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can manage own email connections"
  ON public.email_connections
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.email_connections
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.email_message_imports
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own email imports"
  ON public.email_message_imports
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Anyone can read embassies"
  ON public.embassies
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.embassies
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.emergency_info
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own emergency info"
  ON public.emergency_info
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((auth.uid())::text = user_id));
CREATE POLICY "anon read"
  ON public.emergency_numbers
  AS PERMISSIVE
  FOR SELECT
  TO anon
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.emergency_numbers
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "authenticated read"
  ON public.emergency_numbers
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.entry_requirement_changes
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "authenticated read"
  ON public.entry_requirement_changes
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY "authenticated read"
  ON public.entry_requirements
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.entry_requirements
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Group members view line items"
  ON public.expense_line_items
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM (expenses e
     JOIN group_members gm ON ((gm.group_id = e.group_id)))
  WHERE ((e.id = expense_line_items.expense_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))));
CREATE POLICY require_mfa_when_enrolled
  ON public.expense_line_items
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.expense_splits
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Group members view splits"
  ON public.expense_splits
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM (expenses e
     JOIN group_members gm ON ((gm.group_id = e.group_id)))
  WHERE ((e.id = expense_splits.expense_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))));
CREATE POLICY "Group members view expenses"
  ON public.expenses
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = expenses.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text))))));
CREATE POLICY "Payer or organizer can update"
  ON public.expenses
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (((paid_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = expenses.group_id) AND (gm.user_id = auth.uid()) AND (gm.role = 'organizer'::text))))));
CREATE POLICY require_mfa_when_enrolled
  ON public.expenses
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Group members add expenses"
  ON public.expenses
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = expenses.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))));
CREATE POLICY require_mfa_when_enrolled
  ON public.feature_flags
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "authenticated read"
  ON public.feature_flags
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.flight_disruptions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own flight disruptions"
  ON public.flight_disruptions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY "fx_rates readable"
  ON public.fx_rates
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.fx_rates
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.group_members
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Members can view group members"
  ON public.group_members
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM group_members gm2
  WHERE ((gm2.group_id = group_members.group_id) AND (gm2.user_id = auth.uid()))))));
CREATE POLICY "Group members send messages"
  ON public.group_messages
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_messages.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text))))));
CREATE POLICY "Author or organizer can update"
  ON public.group_messages
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_messages.group_id) AND (gm.user_id = auth.uid()) AND (gm.role = 'organizer'::text))))));
CREATE POLICY require_mfa_when_enrolled
  ON public.group_messages
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Group members view messages"
  ON public.group_messages
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = group_messages.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text))))));
CREATE POLICY "Users can manage their own health assessments"
  ON public.health_assessments
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.health_assessments
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.hotel_loyalty_cache
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "users own cache"
  ON public.hotel_loyalty_cache
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "users own tokens"
  ON public.hotel_loyalty_tokens
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.hotel_loyalty_tokens
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "service role only"
  ON public.hotel_oauth_sessions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.hotel_oauth_sessions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "users own audit logs"
  ON public.hotel_token_audit_log
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.hotel_token_audit_log
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_full_access_idempotency_keys
  ON public.idempotency_keys
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY service_role_all
  ON public.idempotency_records
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY users_own_records
  ON public.idempotency_records
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.idempotency_records
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own important info"
  ON public.important_information
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.important_information
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.inapp_notifications
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own notifications"
  ON public.inapp_notifications
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.item_ratings
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_only_item_ratings
  ON public.item_ratings
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY "trip editors insert"
  ON public.itinerary_items
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (( SELECT private.can_edit_trip(itinerary_items.trip_id) AS can_edit_trip));
CREATE POLICY "trip editors update"
  ON public.itinerary_items
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (( SELECT private.can_edit_trip(itinerary_items.trip_id) AS can_edit_trip))
  WITH CHECK (( SELECT private.can_edit_trip(itinerary_items.trip_id) AS can_edit_trip));
CREATE POLICY "trip members read"
  ON public.itinerary_items
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (( SELECT private.is_trip_member(itinerary_items.trip_id) AS is_trip_member));
CREATE POLICY require_mfa_when_enrolled
  ON public.itinerary_items
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "trip editors delete"
  ON public.itinerary_items
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (( SELECT private.can_edit_trip(itinerary_items.trip_id) AS can_edit_trip));
CREATE POLICY "trip members read versions"
  ON public.itinerary_versions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (( SELECT private.is_trip_member(itinerary_versions.trip_id) AS is_trip_member));
CREATE POLICY "Users can update their own versions"
  ON public.itinerary_versions
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert their own versions"
  ON public.itinerary_versions
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own versions"
  ON public.itinerary_versions
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.itinerary_versions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.location_points
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own location points"
  ON public.location_points
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((share_id IN ( SELECT location_shares.id
   FROM location_shares
  WHERE (location_shares.user_id = (auth.uid())::text))));
CREATE POLICY "Users manage own location shares"
  ON public.location_shares
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((auth.uid())::text = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.location_shares
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.loyalty_aggregator_connections
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "own connections insert"
  ON public.loyalty_aggregator_connections
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "own connections delete"
  ON public.loyalty_aggregator_connections
  AS PERMISSIVE
  FOR DELETE
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "own connections update"
  ON public.loyalty_aggregator_connections
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "own connections select"
  ON public.loyalty_aggregator_connections
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Members view preferences in group"
  ON public.member_preferences
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = member_preferences.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text))))));
CREATE POLICY "Users manage own preferences"
  ON public.member_preferences
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.member_preferences
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.message_attachments
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.message_reactions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own reactions"
  ON public.message_reactions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.monitored_entities
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own monitored entities"
  ON public.monitored_entities
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.monitoring_events
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can access own monitoring events"
  ON public.monitoring_events
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM monitored_entities me
  WHERE ((me.id = monitoring_events.monitored_entity_id) AND (me.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM trips t
  WHERE ((t.id = monitoring_events.trip_id) AND (t.user_id = auth.uid()))))));
CREATE POLICY "authenticated read"
  ON public.monitoring_providers
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.monitoring_providers
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own notification eligibility"
  ON public.notification_eligibility
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.notification_eligibility
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.oauth_states
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own oauth states"
  ON public.oauth_states
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY "Users can manage own offline packs"
  ON public.offline_trip_packs
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.offline_trip_packs
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY onboarding_completions_insert_own
  ON public.onboarding_completions
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY onboarding_completions_select_own
  ON public.onboarding_completions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY onboarding_completions_update_own
  ON public.onboarding_completions
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.onboarding_completions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY onboarding_completions_delete_own
  ON public.onboarding_completions
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY service_role_all
  ON public.operation_attempts
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY service_role_full_access_operation_locks
  ON public.operation_locks
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.pace_analyses
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own pace analyses"
  ON public.pace_analyses
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "trip editors insert"
  ON public.packing_items
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (( SELECT private.can_edit_trip(packing_items.trip_id) AS can_edit_trip));
CREATE POLICY "trip editors update"
  ON public.packing_items
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (( SELECT private.can_edit_trip(packing_items.trip_id) AS can_edit_trip))
  WITH CHECK (( SELECT private.can_edit_trip(packing_items.trip_id) AS can_edit_trip));
CREATE POLICY "trip members read"
  ON public.packing_items
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (( SELECT private.is_trip_member(packing_items.trip_id) AS is_trip_member));
CREATE POLICY require_mfa_when_enrolled
  ON public.packing_items
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "trip editors delete"
  ON public.packing_items
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (( SELECT private.can_edit_trip(packing_items.trip_id) AS can_edit_trip));
CREATE POLICY require_mfa_when_enrolled
  ON public.personal_calibration
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY own_calibration
  ON public.personal_calibration
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = (auth.uid())::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.phrase_cards
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "authenticated read"
  ON public.phrase_cards
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY "Users see own recovery logs"
  ON public.pipeline_recovery_log
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.pipeline_recovery_log
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own plan changes"
  ON public.plan_changes
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.plan_changes
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own planning sessions"
  ON public.planning_sessions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.planning_sessions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own connections"
  ON public.platform_connections
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.platform_connections
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Group members view options"
  ON public.poll_options
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM (polls p
     JOIN group_members gm ON ((gm.group_id = p.group_id)))
  WHERE ((p.id = poll_options.poll_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))));
CREATE POLICY require_mfa_when_enrolled
  ON public.poll_options
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.poll_options_v2
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_write_options
  ON public.poll_options_v2
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY trip_members_read_options
  ON public.poll_options_v2
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM polls_v2 p
  WHERE ((p.id = poll_options_v2.poll_id) AND private.is_trip_member(p.trip_id)))));
CREATE POLICY "Users cast votes"
  ON public.poll_votes
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.poll_votes
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users view own votes"
  ON public.poll_votes
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY "Group members view polls"
  ON public.polls
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = polls.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))) OR (created_by = auth.uid())));
CREATE POLICY require_mfa_when_enrolled
  ON public.polls
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Group members create polls"
  ON public.polls
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = created_by));
CREATE POLICY service_role_write_polls
  ON public.polls_v2
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY require_mfa_when_enrolled
  ON public.polls_v2
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY trip_members_read_polls
  ON public.polls_v2
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.pre_trip_readiness
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own readiness"
  ON public.pre_trip_readiness
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.pre_trip_tasks
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own tasks"
  ON public.pre_trip_tasks
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY service_only_prediction_models
  ON public.prediction_models
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.prediction_models
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "trip members read"
  ON public.prep_items
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (( SELECT private.is_trip_member(prep_items.trip_id) AS is_trip_member));
CREATE POLICY "trip members insert own item"
  ON public.prep_items
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((( SELECT private.is_trip_member(prep_items.trip_id) AS is_trip_member) AND (member_id = ( SELECT private.current_platform_user_id() AS current_platform_user_id))));
CREATE POLICY require_mfa_when_enrolled
  ON public.prep_items
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "own item update"
  ON public.prep_items
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((member_id = ( SELECT private.current_platform_user_id() AS current_platform_user_id)))
  WITH CHECK ((member_id = ( SELECT private.current_platform_user_id() AS current_platform_user_id)));
CREATE POLICY require_mfa_when_enrolled
  ON public.price_snapshots
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own price snapshots"
  ON public.price_snapshots
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY profile_signals_delete_own
  ON public.profile_signals
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY profile_signals_insert_own
  ON public.profile_signals
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY profile_signals_select_own
  ON public.profile_signals
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.profile_signals
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY profile_signals_update_own
  ON public.profile_signals
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update own profile"
  ON public.profiles
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = id));
CREATE POLICY require_mfa_when_enrolled
  ON public.profiles
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can view own profile"
  ON public.profiles
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = id));
CREATE POLICY "Users can insert own profile"
  ON public.profiles
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = id));
CREATE POLICY require_mfa_when_enrolled
  ON public.rate_limit_buckets
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_only
  ON public.rate_limit_buckets
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY service_only_rating_prompt_state
  ON public.rating_prompt_state
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.rating_prompt_state
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.readiness_items
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own readiness items"
  ON public.readiness_items
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users delete own engagement"
  ON public.recommendation_engagement
  AS PERMISSIVE
  FOR DELETE
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users write own engagement"
  ON public.recommendation_engagement
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.recommendation_engagement
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY read_own_engagement
  ON public.recommendation_engagement
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));
CREATE POLICY "Public read trending"
  ON public.recommendation_trending
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.recommendation_trending
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.recommendations
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own recommendations"
  ON public.recommendations
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.reservation_poll_schedule
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own poll schedule"
  ON public.reservation_poll_schedule
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users view own price history"
  ON public.reservation_price_history
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.reservation_price_history
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own reservations"
  ON public.reservations
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.reservations
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Members can read all responses in their rollcall"
  ON public.rollcall_responses
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((rollcall_id IN ( SELECT r.id
   FROM rollcalls r
  WHERE (r.trip_id IN ( SELECT tm.trip_id
           FROM trip_members tm
          WHERE ((tm.user_id = private.current_platform_user_id()) AND (tm.removed_at IS NULL)))))));
CREATE POLICY "Members manage own rollcall responses"
  ON public.rollcall_responses
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((member_id = private.current_platform_user_id()))
  WITH CHECK ((member_id = private.current_platform_user_id()));
CREATE POLICY require_mfa_when_enrolled
  ON public.rollcall_responses
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Authenticated users can create rollcalls"
  ON public.rollcalls
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((triggered_by = private.current_platform_user_id()));
CREATE POLICY "Trip members can read rollcalls"
  ON public.rollcalls
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((trip_id IN ( SELECT tm.trip_id
   FROM trip_members tm
  WHERE ((tm.user_id = private.current_platform_user_id()) AND (tm.removed_at IS NULL)))) OR (triggered_by = private.current_platform_user_id())));
CREATE POLICY require_mfa_when_enrolled
  ON public.rollcalls
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.safety_advisories
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "authenticated read"
  ON public.safety_advisories
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY "Users can manage their own safety assessments"
  ON public.safety_assessments
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.safety_assessments
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "trip members read"
  ON public.safety_notes
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (( SELECT private.is_trip_member(safety_notes.trip_id) AS is_trip_member));
CREATE POLICY require_mfa_when_enrolled
  ON public.safety_notes
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "own preferences"
  ON public.safety_preferences
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING ((user_id = ( SELECT private.current_platform_user_id() AS current_platform_user_id)))
  WITH CHECK ((user_id = ( SELECT private.current_platform_user_id() AS current_platform_user_id)));
CREATE POLICY require_mfa_when_enrolled
  ON public.safety_preferences
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.safety_reports
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "reporter insert"
  ON public.safety_reports
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((reporter_id = ( SELECT private.current_platform_user_id() AS current_platform_user_id)) AND ( SELECT private.is_trip_member(safety_reports.trip_id) AS is_trip_member)));
CREATE POLICY "trip members read"
  ON public.safety_reports
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (( SELECT private.is_trip_member(safety_reports.trip_id) AS is_trip_member));
CREATE POLICY "reporter update"
  ON public.safety_reports
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((reporter_id = ( SELECT private.current_platform_user_id() AS current_platform_user_id)))
  WITH CHECK ((reporter_id = ( SELECT private.current_platform_user_id() AS current_platform_user_id)));
CREATE POLICY require_mfa_when_enrolled
  ON public.satisfaction_ledger
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_all_ledger
  ON public.satisfaction_ledger
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Users manage own saved"
  ON public.saved_recommendations
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.saved_recommendations
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "own row read"
  ON public.search_analytics
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.search_analytics
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own documents"
  ON public.secure_documents
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.secure_documents
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.serendipity_dismissed
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_only_seren_dismissed
  ON public.serendipity_dismissed
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.serendipity_preferences
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_only_seren_prefs
  ON public.serendipity_preferences
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY service_only_seren_suggestions
  ON public.serendipity_suggestions
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false);
CREATE POLICY require_mfa_when_enrolled
  ON public.serendipity_suggestions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY require_mfa_when_enrolled
  ON public.settlements
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Group members view settlements"
  ON public.settlements
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = settlements.group_id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))));
CREATE POLICY "Anyone can view valid shareable calendars by token"
  ON public.shareable_calendars
  AS PERMISSIVE
  FOR SELECT
  TO authenticated, anon
  USING ((expires_at > now()));
CREATE POLICY require_mfa_when_enrolled
  ON public.shareable_calendars
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own shareable calendars"
  ON public.shareable_calendars
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING ((created_by = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.taxonomy_versions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY public_read_taxonomy
  ON public.taxonomy_versions
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.traffic_updates
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own traffic updates"
  ON public.traffic_updates
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.travel_alerts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own alerts"
  ON public.travel_alerts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY service_role_all
  ON public.travel_operations
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY require_mfa_when_enrolled
  ON public.travel_operations
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY users_own_operations
  ON public.travel_operations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));
CREATE POLICY traveler_profiles_select_own
  ON public.traveler_profiles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY traveler_profiles_insert_own
  ON public.traveler_profiles
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY traveler_profiles_delete_own
  ON public.traveler_profiles
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.traveler_profiles
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY traveler_profiles_update_own
  ON public.traveler_profiles
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_assemblies
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own trip assemblies"
  ON public.trip_assemblies
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert own trip changes"
  ON public.trip_change_log
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_change_log
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can update own trip changes"
  ON public.trip_change_log
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can view own trip changes"
  ON public.trip_change_log
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_change_previews
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage own previews"
  ON public.trip_change_previews
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_forecasts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY service_role_forecast_write
  ON public.trip_forecasts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.role() = 'service_role'::text));
CREATE POLICY trip_members_forecast
  ON public.trip_forecasts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (private.is_trip_member(trip_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_groups
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Creators can manage"
  ON public.trip_groups
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((created_by = auth.uid()));
CREATE POLICY "Group members can view"
  ON public.trip_groups
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((EXISTS ( SELECT 1
   FROM group_members gm
  WHERE ((gm.group_id = trip_groups.id) AND (gm.user_id = auth.uid()) AND (gm.status = 'active'::text)))) OR (created_by = auth.uid())));
CREATE POLICY "Users can insert their own health analyses"
  ON public.trip_health_analyses
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own health analyses"
  ON public.trip_health_analyses
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_health_analyses
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can update their own health analyses"
  ON public.trip_health_analyses
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can manage own trip impacts"
  ON public.trip_impacts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_impacts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can update their own issues"
  ON public.trip_issues
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_issues
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can view their own issues"
  ON public.trip_issues
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert their own issues"
  ON public.trip_issues
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trip_planning_preferences
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own planning preferences"
  ON public.trip_planning_preferences
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.trips
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own trips"
  ON public.trips
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users manage own typing"
  ON public.typing_indicators
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.typing_indicators
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "own row read"
  ON public.user_actions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.user_actions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own alert prefs"
  ON public.user_alert_preferences
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.user_alert_preferences
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "own row read"
  ON public.user_behavior_profiles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.user_behavior_profiles
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "own row read"
  ON public.user_limits
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.user_limits
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own push tokens"
  ON public.user_push_tokens
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.user_push_tokens
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users manage own profiles"
  ON public.user_recommendation_profiles
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((auth.uid() = user_id));
CREATE POLICY require_mfa_when_enrolled
  ON public.user_recommendation_profiles
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
CREATE POLICY "Users can manage their own weather forecasts"
  ON public.weather_forecasts
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((user_id = auth.uid()));
CREATE POLICY require_mfa_when_enrolled
  ON public.weather_forecasts
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (( SELECT private.mfa_satisfied() AS mfa_satisfied))
  WITH CHECK (( SELECT private.mfa_satisfied() AS mfa_satisfied));
