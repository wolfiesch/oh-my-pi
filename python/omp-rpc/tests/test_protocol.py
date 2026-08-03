from __future__ import annotations

import json
import unittest
from pathlib import Path

from omp_rpc import (
    AgentEndEvent,
    AutoCompactionEndEvent,
    AutoCompactionStartEvent,
    ExtensionUiRequest,
    JobUpdateEvent,
    ModeChangeResult,
    OperationCancelledEvent,
    OperationCompletedEvent,
    OperationFailedEvent,
    OperationStartedEvent,
    PlanApprovalRequestEvent,
    PlanApprovalSettledEvent,
    PlanStateUpdateEvent,
    ProviderAuthRequest,
    ProviderAuthUpdate,
    QueueUpdateEvent,
    ReadyEvent,
    SessionState,
    SubagentEvent,
    SubagentLifecycleEvent,
    SubagentProgressEvent,
    TodoReminderEvent,
    ToolActivationResult,
    ToolInventoryUpdateEvent,
    assistant_text,
    assistant_text_with_thinking,
    parse_advisor_state,
    parse_mode_change_result,
    parse_notification,
    parse_session_state,
    parse_tool_activation_result,
    parse_tool_inventory,
)


class ProtocolParsingTests(unittest.TestCase):
    def test_parse_operation_lifecycle_notifications(self) -> None:
        started = parse_notification(
            {
                "type": "operation_started",
                "operationId": "operation-1",
                "requestId": "request-1",
                "command": "prompt",
                "startedAt": 10,
                "futureField": True,
            }
        )
        completed = parse_notification(
            {
                "type": "operation_completed",
                "operationId": "operation-1",
                "requestId": "request-1",
                "command": "prompt",
                "agentInvoked": True,
                "settledAt": 11,
            }
        )
        failed = parse_notification(
            {
                "type": "operation_failed",
                "operationId": "operation-2",
                "command": "prompt",
                "error": "no model",
                "code": "prompt_scheduling_failed",
                "settledAt": 12,
            }
        )
        cancelled = parse_notification(
            {
                "type": "operation_cancelled",
                "operationId": "operation-3",
                "command": "abort_and_prompt",
                "reason": "user",
                "code": "cancelled_by_client",
                "settledAt": 13,
            }
        )

        self.assertIsInstance(started, OperationStartedEvent)
        self.assertIsInstance(completed, OperationCompletedEvent)
        self.assertTrue(completed.agent_invoked)
        self.assertEqual(completed.request_id, "request-1")
        self.assertIsInstance(failed, OperationFailedEvent)
        self.assertEqual(failed.code, "prompt_scheduling_failed")
        self.assertIsInstance(cancelled, OperationCancelledEvent)
        self.assertEqual(cancelled.reason, "user")

    def test_parse_ready_capability_manifest(self) -> None:
        manifest = json.loads(
            (
                Path(__file__).parent / "fixtures" / "rpc-capability-manifest.json"
            ).read_text(encoding="utf-8")
        )
        notification = parse_notification(
            {
                "type": "ready",
                "protocolVersion": 1,
                "capabilities": manifest,
            }
        )

        self.assertIsInstance(notification, ReadyEvent)
        self.assertIsNotNone(notification.capabilities)
        assert notification.capabilities is not None
        capability = notification.capabilities.commands[0]
        self.assertEqual(notification.capabilities.application_api_version, 2)
        self.assertEqual(capability.id, "rpc.command.get_capabilities")
        self.assertEqual(capability.name, "get_capabilities")
        self.assertEqual(capability.scope, "host")
        self.assertEqual(capability.execution, "sync")
        self.assertEqual(capability.availability, "available")
        self.assertEqual(capability.concurrency_class, "serial")
        self.assertEqual(capability.confirmation, "none")
        self.assertEqual(capability.required_features, ())
        self.assertEqual(capability.input_schema["type"], "object")
        self.assertIn("future_event", notification.capabilities.events)
        activation = next(
            command
            for command in notification.capabilities.commands
            if command.name == "set_tool_activation"
        )
        self.assertEqual(activation.scope, "session")
        self.assertEqual(activation.execution, "sync")
        self.assertEqual(activation.concurrency_class, "serial")

    def test_parse_ready_preserves_future_capability_classifiers(self) -> None:
        manifest = json.loads(
            (
                Path(__file__).parent / "fixtures" / "rpc-capability-manifest.json"
            ).read_text(encoding="utf-8")
        )
        capability = manifest["commands"][0]
        capability["scope"] = "future-scope"
        capability["execution"] = "future-execution"
        capability["availability"] = "future-availability"
        capability["concurrencyClass"] = "future-concurrency"

        notification = parse_notification(
            {
                "type": "ready",
                "protocolVersion": 1,
                "capabilities": manifest,
            }
        )

        self.assertIsInstance(notification, ReadyEvent)
        assert isinstance(notification, ReadyEvent)
        assert notification.capabilities is not None
        parsed = notification.capabilities.commands[0]
        self.assertEqual(parsed.scope, "future-scope")
        self.assertEqual(parsed.execution, "future-execution")
        self.assertEqual(parsed.availability, "future-availability")
        self.assertEqual(parsed.concurrency_class, "future-concurrency")

    def test_parse_plan_notifications_with_unknown_fields(self) -> None:
        state = parse_notification(
            {
                "type": "plan_state_update",
                "state": {
                    "mode": "future-plan-mode",
                    "planFilePath": "local://PLAN.md",
                    "workflow": "parallel",
                    "futureField": True,
                },
                "futureEnvelopeField": True,
            }
        )
        request = parse_notification(
            {
                "type": "plan_approval_request",
                "approvalId": "approval-1",
                "planFilePath": "local://PLAN.md",
                "title": "Fixture plan",
                "planContent": "# Fixture plan",
                "futureField": True,
            }
        )
        settled = parse_notification(
            {
                "type": "plan_approval_settled",
                "approvalId": "approval-1",
                "result": {
                    "approvalId": "approval-1",
                    "decision": "refine",
                    "executionDispatched": False,
                    "planFilePath": "local://PLAN.md",
                    "futureField": True,
                },
            }
        )

        self.assertIsInstance(state, PlanStateUpdateEvent)
        self.assertEqual(state.state.mode, "none")
        self.assertIsInstance(request, PlanApprovalRequestEvent)
        self.assertEqual(request.approval_id, "approval-1")
        self.assertIsInstance(settled, PlanApprovalSettledEvent)
        self.assertEqual(settled.result.decision, "refine")

    def test_plan_settlement_requires_execution_dispatched_boolean(self) -> None:
        base = {
            "type": "plan_approval_settled",
            "approvalId": "approval-1",
            "result": {
                "approvalId": "approval-1",
                "decision": "approve",
                "planFilePath": "local://PLAN.md",
            },
        }
        with self.assertRaisesRegex(ValueError, "executionDispatched"):
            parse_notification(base)
        base["result"]["executionDispatched"] = "false"
        with self.assertRaisesRegex(ValueError, "executionDispatched"):
            parse_notification(base)

    def test_parse_mode_change_result_requires_acceptance_and_deferred(self) -> None:
        result = parse_mode_change_result(
            {
                "operationId": "operation-mode",
                "accepted": True,
                "deferred": False,
            }
        )
        self.assertIsInstance(result, ModeChangeResult)
        self.assertEqual(result.operation_id, "operation-mode")
        with self.assertRaisesRegex(ValueError, "accepted must be true"):
            parse_mode_change_result(
                {
                    "operationId": "operation-mode",
                    "accepted": False,
                    "deferred": False,
                }
            )
        with self.assertRaisesRegex(ValueError, "deferred"):
            parse_mode_change_result(
                {"operationId": "operation-mode", "accepted": True}
            )

    def test_parse_ready_requires_a_known_confirmation_requirement(self) -> None:
        manifest = json.loads(
            (
                Path(__file__).parent / "fixtures" / "rpc-capability-manifest.json"
            ).read_text(encoding="utf-8")
        )
        manifest["commands"][0]["confirmation"] = "required"
        notification = parse_notification(
            {"type": "ready", "protocolVersion": 1, "capabilities": manifest}
        )
        assert isinstance(notification, ReadyEvent)
        assert notification.capabilities is not None
        self.assertEqual(notification.capabilities.commands[0].confirmation, "required")

        manifest["commands"][0]["confirmation"] = "future-confirmation"
        with self.assertRaises(ValueError):
            parse_notification(
                {"type": "ready", "protocolVersion": 1, "capabilities": manifest}
            )

    def test_parse_session_state(self) -> None:
        state = parse_session_state(
            {
                "model": {
                    "id": "claude-sonnet-4-5",
                    "name": "Claude Sonnet 4.5",
                    "api": "anthropic-messages",
                    "provider": "anthropic",
                    "baseUrl": "https://api.anthropic.com",
                    "reasoning": True,
                    "input": ["text", "image"],
                    "cost": {
                        "input": 1.0,
                        "output": 2.0,
                        "cacheRead": 0.1,
                        "cacheWrite": 0.2,
                    },
                    "contextWindow": 200000,
                    "maxTokens": 8192,
                    "thinking": {
                        "mode": "effort",
                        "efforts": ["minimal", "low", "medium", "high"],
                        "defaultLevel": "medium",
                        "effortMap": {"high": "xhigh"},
                        "supportsDisplay": True,
                    },
                },
                "thinkingLevel": "medium",
                "isStreaming": False,
                "activityPhase": "maintenance",
                "isCompacting": False,
                "steeringMode": "one-at-a-time",
                "followUpMode": "all",
                "interruptMode": "immediate",
                "sessionFile": "/tmp/test.jsonl",
                "sessionId": "session-123",
                "sessionName": "Scratchpad",
                "fastModeEnabled": False,
                "fastModeActive": True,
                "tokensPerSecond": 12.5,
                "autoCompactionEnabled": True,
                "messageCount": 4,
                "queuedMessageCount": 1,
                "todoPhases": [
                    {
                        "id": "phase-1",
                        "name": "Todos",
                        "tasks": [
                            {
                                "id": "task-1",
                                "content": "Map tools",
                                "status": "in_progress",
                                "details": "Inspect read and edit first.",
                            }
                        ],
                    }
                ],
                "systemPrompt": "You are useful.",
                "dumpTools": [
                    {
                        "name": "read",
                        "description": "Read files",
                        "parameters": {"type": "object"},
                    }
                ],
                "contextUsage": {
                    "tokens": 12345,
                    "contextWindow": 200000,
                    "percent": 6.1725,
                },
            }
        )

        self.assertIsInstance(state, SessionState)
        self.assertEqual(state.session_id, "session-123")
        self.assertEqual(state.follow_up_mode, "all")
        self.assertEqual(state.activity_phase, "maintenance")
        self.assertEqual(state.model.id if state.model else None, "claude-sonnet-4-5")
        self.assertEqual(state.todo_phases[0].tasks[0].status, "in_progress")
        # Legacy bare-string systemPrompt is accepted and wrapped to a tuple.
        self.assertEqual(state.system_prompt, ("You are useful.",))
        self.assertEqual(state.dump_tools[0].name, "read")
        assert state.context_usage is not None
        self.assertEqual(state.context_usage.tokens, 12345)
        self.assertEqual(state.context_usage.context_window, 200000)
        self.assertEqual(state.context_usage.percent, 6.1725)
        assert state.model is not None and state.model.thinking is not None
        self.assertEqual(
            state.model.thinking.efforts, ("minimal", "low", "medium", "high")
        )
        self.assertEqual(state.model.thinking.mode, "effort")
        self.assertEqual(state.model.thinking.default_level, "medium")
        self.assertEqual(state.model.thinking.effort_map, {"high": "xhigh"})
        self.assertTrue(state.model.thinking.supports_display)
        self.assertFalse(state.fast_mode_enabled)
        self.assertTrue(state.fast_mode_active)
        self.assertEqual(state.tokens_per_second, 12.5)

    def test_parse_advisor_state_keeps_configured_and_active_distinct(self) -> None:
        advisor = parse_advisor_state(
            {
                "configured": True,
                "active": False,
                "advisors": [{"name": "reviewer", "status": "no_model"}],
            }
        )

        self.assertIsNotNone(advisor)
        assert advisor is not None
        self.assertTrue(advisor.configured)
        self.assertFalse(advisor.active)
        self.assertEqual(advisor.advisors[0].status, "no_model")

    def test_parse_session_state_accepts_missing_advisor_snapshot(self) -> None:
        state = parse_session_state(
            {
                "sessionId": "session-123",
                "steeringMode": "one-at-a-time",
                "followUpMode": "all",
                "interruptMode": "immediate",
            }
        )
        self.assertIsNone(state.advisor)

    def test_advisor_parser_rejects_malformed_and_future_status_snapshots(self) -> None:
        self.assertIsNone(parse_advisor_state({}))
        self.assertIsNone(
            parse_advisor_state(
                {
                    "configured": True,
                    "active": True,
                    "advisors": [{"name": "reviewer", "status": "future_status"}],
                }
            )
        )
        state = parse_session_state(
            {
                "sessionId": "session-123",
                "steeringMode": "one-at-a-time",
                "followUpMode": "all",
                "interruptMode": "immediate",
                "advisor": {},
            }
        )
        self.assertIsNone(state.advisor)

    def test_parse_session_state_defaults_missing_fast_mode_and_throughput(
        self,
    ) -> None:
        missing = object()
        for tokens_per_second, expected in (
            (None, None),
            (missing, None),
        ):
            with self.subTest(tokens_per_second=tokens_per_second):
                payload = {
                    "sessionId": "session-123",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "all",
                    "interruptMode": "immediate",
                }
                if tokens_per_second is not missing:
                    payload["tokensPerSecond"] = tokens_per_second

                state = parse_session_state(payload)

                self.assertEqual(
                    (
                        state.fast_mode_enabled,
                        state.fast_mode_active,
                        state.tokens_per_second,
                    ),
                    (False, False, expected),
                )

    def test_parse_agent_end_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "agent_end",
                "messages": [
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hello"}],
                        "api": "anthropic-messages",
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-5",
                        "usage": {
                            "input": 1,
                            "output": 1,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "totalTokens": 2,
                            "cost": {
                                "input": 0.0,
                                "output": 0.0,
                                "cacheRead": 0.0,
                                "cacheWrite": 0.0,
                                "total": 0.0,
                            },
                        },
                        "stopReason": "stop",
                        "timestamp": 1,
                    }
                ],
                "messageCount": 1,
                "isTerminal": False,
            }
        )

        self.assertIsInstance(notification, AgentEndEvent)
        self.assertEqual(assistant_text(notification.messages[0]), "hello")
        self.assertEqual(notification.message_count, 1)
        self.assertFalse(notification.is_terminal)

        legacy = AgentEndEvent(notification.messages, "agent_end")
        self.assertEqual(legacy.type, "agent_end")
        self.assertIsNone(legacy.message_count)
        self.assertIsNone(legacy.is_terminal)

    def test_parse_current_compaction_variants(self) -> None:
        start = parse_notification(
            {
                "type": "auto_compaction_start",
                "reason": "incomplete",
                "action": "snapcompact",
            }
        )
        end = parse_notification(
            {
                "type": "auto_compaction_end",
                "action": "shake",
                "result": None,
                "aborted": False,
                "willRetry": False,
            }
        )

        self.assertIsInstance(start, AutoCompactionStartEvent)
        self.assertEqual(start.reason, "incomplete")
        self.assertEqual(start.action, "snapcompact")
        self.assertIsInstance(end, AutoCompactionEndEvent)
        self.assertEqual(end.action, "shake")

    def test_parse_extension_ui_request(self) -> None:
        notification = parse_notification(
            {
                "type": "extension_ui_request",
                "id": "ui-1",
                "method": "input",
                "title": "API key",
                "placeholder": "sk-...",
                "timeout": 1000,
                "sensitive": True,
                "operationId": "operation-auth",
                "purpose": "provider_auth",
                "providerId": "openrouter",
            }
        )

        self.assertIsInstance(notification, ExtensionUiRequest)
        self.assertEqual(notification.method, "input")
        self.assertEqual(notification.placeholder, "sk-...")
        self.assertTrue(notification.sensitive)
        self.assertEqual(notification.operation_id, "operation-auth")
        self.assertEqual(notification.purpose, "provider_auth")
        self.assertEqual(notification.provider_id, "openrouter")
        self.assertTrue(notification.is_interactive())
        self.assertTrue(notification.requires_response())
        self.assertFalse(notification.is_passive())

    def test_parse_privileged_extension_ui_request(self) -> None:
        notification = parse_notification(
            {
                "type": "extension_ui_request",
                "id": "ui-eval",
                "method": "confirm",
                "title": "Run eval code?",
                "message": "display(2 + 2)",
                "operationId": "operation-eval",
                "command": "eval_execute",
            }
        )

        self.assertIsInstance(notification, ExtensionUiRequest)
        self.assertEqual(notification.operation_id, "operation-eval")
        self.assertEqual(notification.command, "eval_execute")

    def test_reject_unknown_privileged_extension_ui_command(self) -> None:
        with self.assertRaisesRegex(ValueError, "extension_ui_request.command"):
            parse_notification(
                {
                    "type": "extension_ui_request",
                    "id": "ui-unknown",
                    "method": "confirm",
                    "title": "Unknown command?",
                    "message": "Do something privileged",
                    "operationId": "operation-unknown",
                    "command": "shell",
                }
            )

    def test_parse_open_url_request(self) -> None:
        notification = parse_notification(
            {
                "type": "extension_ui_request",
                "id": "ui-oauth",
                "method": "open_url",
                "url": "https://example.com/oauth",
                "launchUrl": "http://127.0.0.1:8123/redirect",
                "instructions": "Open this URL to continue.",
            }
        )

        self.assertIsInstance(notification, ExtensionUiRequest)
        self.assertEqual(notification.method, "open_url")
        self.assertEqual(notification.url, "https://example.com/oauth")
        self.assertEqual(notification.launch_url, "http://127.0.0.1:8123/redirect")
        self.assertTrue(notification.is_passive())

    def test_parse_todo_reminder_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "todo_reminder",
                "attempt": 1,
                "maxAttempts": 3,
                "todos": [
                    {
                        "id": "task-1",
                        "content": "Map tools",
                        "status": "pending",
                    }
                ],
            }
        )

        self.assertIsInstance(notification, TodoReminderEvent)
        self.assertEqual(notification.todos[0].content, "Map tools")
        self.assertEqual(notification.todos[0].status, "pending")

    def test_parse_session_state_accepts_blocked_todo(self) -> None:
        # Regression: the TS agent added a `blocked` todo status (with a
        # `blocker` note); resuming a session whose todos were blocked must
        # not fail state parsing.
        state = parse_session_state(
            {
                "sessionId": "session-123",
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "interruptMode": "immediate",
                "todoPhases": [
                    {
                        "id": "phase-1",
                        "name": "Fix",
                        "tasks": [
                            {
                                "id": "task-1",
                                "content": "Open PR",
                                "status": "blocked",
                                "blocker": "waiting on maintainer go-ahead",
                            }
                        ],
                    }
                ],
            }
        )

        task = state.todo_phases[0].tasks[0]
        self.assertEqual(task.status, "blocked")
        self.assertEqual(task.blocker, "waiting on maintainer go-ahead")

    def test_assistant_text_excludes_thinking_by_default(self) -> None:
        message = {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "internal"},
                {"type": "text", "text": "visible"},
            ],
        }

        self.assertEqual(assistant_text(message), "visible")
        self.assertEqual(assistant_text_with_thinking(message), "internalvisible")

    def test_parse_session_state_rejects_invalid_thinking_level(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-123",
                    "thinkingLevel": "extreme",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                }
            )

    def test_parse_session_state_activity_phases_are_forward_compatible(self) -> None:
        base_state = {
            "sessionId": "session-123",
            "steeringMode": "one-at-a-time",
            "followUpMode": "one-at-a-time",
            "interruptMode": "immediate",
        }
        for activity_phase in ("provider", "maintenance", "idle"):
            with self.subTest(activity_phase=activity_phase):
                state = parse_session_state(
                    {**base_state, "activityPhase": activity_phase}
                )
                self.assertEqual(state.activity_phase, activity_phase)

        future = parse_session_state(
            {**base_state, "activityPhase": "future-settlement-phase"}
        )
        self.assertEqual(future.activity_phase, "maintenance")
        explicit_null = parse_session_state(
            {**base_state, "activityPhase": None, "isStreaming": False}
        )
        self.assertEqual(explicit_null.activity_phase, "maintenance")

        legacy_streaming = parse_session_state({**base_state, "isStreaming": True})
        legacy_idle = parse_session_state(base_state)
        self.assertEqual(legacy_streaming.activity_phase, "maintenance")
        self.assertEqual(legacy_idle.activity_phase, "idle")

    def test_parse_model_info_rejects_unknown_effort(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-123",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                    "model": {
                        "id": "m",
                        "name": "M",
                        "api": "anthropic-messages",
                        "provider": "anthropic",
                        "baseUrl": "https://api.anthropic.com",
                        "reasoning": True,
                        "thinking": {"mode": "effort", "efforts": ["extreme"]},
                    },
                }
            )

    def test_parse_session_state_accepts_system_prompt_array(self) -> None:
        state = parse_session_state(
            {
                "sessionId": "session-abc",
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "interruptMode": "immediate",
                "systemPrompt": ["base instructions", "extra policy"],
            }
        )
        self.assertEqual(state.system_prompt, ("base instructions", "extra policy"))

    def test_parse_session_state_defaults_system_prompt_to_empty_tuple(self) -> None:
        state = parse_session_state(
            {
                "sessionId": "session-abc",
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "interruptMode": "immediate",
            }
        )
        self.assertEqual(state.system_prompt, ())

    def test_parse_session_state_rejects_non_string_in_system_prompt_array(
        self,
    ) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-abc",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                    "systemPrompt": ["ok", 42],
                }
            )

    def test_parse_session_state_rejects_invalid_system_prompt_shape(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-abc",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                    "systemPrompt": {"unexpected": "object"},
                }
            )

    def test_parse_extension_ui_request_rejects_invalid_method(self) -> None:
        with self.assertRaises(ValueError):
            parse_notification(
                {"type": "extension_ui_request", "id": "ui-1", "method": "launch"}
            )

    def test_parse_message_update_rejects_invalid_assistant_done_reason(self) -> None:
        with self.assertRaises(ValueError):
            parse_notification(
                {
                    "type": "message_update",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hello"}],
                        "api": "anthropic-messages",
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-5",
                        "usage": {
                            "input": 1,
                            "output": 1,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "totalTokens": 2,
                            "cost": {
                                "input": 0.0,
                                "output": 0.0,
                                "cacheRead": 0.0,
                                "cacheWrite": 0.0,
                                "total": 0.0,
                            },
                        },
                        "stopReason": "stop",
                        "timestamp": 1,
                    },
                    "assistantMessageEvent": {
                        "type": "done",
                        "reason": "error",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "hello"}],
                            "api": "anthropic-messages",
                            "provider": "anthropic",
                            "model": "claude-sonnet-4-5",
                            "usage": {
                                "input": 1,
                                "output": 1,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                                "totalTokens": 2,
                                "cost": {
                                    "input": 0.0,
                                    "output": 0.0,
                                    "cacheRead": 0.0,
                                    "cacheWrite": 0.0,
                                    "total": 0.0,
                                },
                            },
                            "stopReason": "stop",
                            "timestamp": 1,
                        },
                    },
                }
            )

    def test_parse_notification_deep_clones_nested_messages(self) -> None:
        payload = {
            "type": "agent_end",
            "messages": [
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hello"}],
                    "api": "anthropic-messages",
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-5",
                    "usage": {
                        "input": 1,
                        "output": 1,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 2,
                        "cost": {
                            "input": 0.0,
                            "output": 0.0,
                            "cacheRead": 0.0,
                            "cacheWrite": 0.0,
                            "total": 0.0,
                        },
                    },
                    "stopReason": "stop",
                    "timestamp": 1,
                }
            ],
        }

        notification = parse_notification(payload)
        payload["messages"][0]["content"][0]["text"] = "mutated"

        self.assertIsInstance(notification, AgentEndEvent)
        self.assertEqual(notification.messages[0]["content"][0]["text"], "hello")

    def test_parse_tool_inventory_full_and_future_safe(self) -> None:
        parameters = {"type": "object", "properties": {"query": {"type": "string"}}}
        payload = {
            "applicationApiVersion": 2,
            "tools": [
                {
                    "name": "mcp__server_search",
                    "label": "Search",
                    "description": "Search remotely",
                    "summary": "Remote search",
                    "parameters": parameters,
                    "presentation": "mounted",
                    "loadMode": "discoverable",
                    "hidden": False,
                    "deferrable": True,
                    "strict": False,
                    "customWireName": "remote_search",
                    "source": {
                        "kind": "mcp",
                        "serverName": "server",
                        "remoteName": "search",
                        "futureSourceField": "ignored",
                    },
                    "futureToolField": "ignored",
                }
            ],
            "xdev": {"prefix": "xd://", "mountedCount": 1, "futureXdevField": True},
            "futureTopLevelField": True,
        }
        inventory = parse_tool_inventory(payload)
        parameters["properties"]["query"]["type"] = "integer"

        self.assertEqual(inventory.application_api_version, 2)
        self.assertEqual(inventory.xdev.prefix, "xd://")
        self.assertEqual(inventory.xdev.mounted_count, 1)
        entry = inventory.tools[0]
        self.assertEqual(entry.presentation, "mounted")
        self.assertEqual(entry.load_mode, "discoverable")
        self.assertEqual(entry.custom_wire_name, "remote_search")
        self.assertEqual(entry.source.kind, "mcp")
        self.assertEqual(entry.source.server_name, "server")
        self.assertEqual(entry.source.remote_name, "search")
        self.assertEqual(entry.parameters["properties"]["query"]["type"], "string")

    def test_provider_auth_parsing_is_secret_free_and_future_tolerant(self) -> None:
        request = parse_notification(
            {
                "type": "provider_auth_request",
                "operationId": "operation-auth",
                "requestId": "request-auth",
                "providerId": "openrouter",
                "method": "open_url",
                "url": "https://auth.example.test/start",
            }
        )
        self.assertIsInstance(request, ProviderAuthRequest)
        self.assertEqual(request.method, "open_url")
        self.assertEqual(request.url, "https://auth.example.test/start")
        with self.assertRaisesRegex(ValueError, "must be open_url"):
            parse_notification(
                {
                    "type": "provider_auth_request",
                    "operationId": "operation-auth",
                    "requestId": "request-secret",
                    "providerId": "openrouter",
                    "method": "future_secret_method",
                    "prompt": "Enter credential",
                }
            )
        update = parse_notification(
            {
                "type": "provider_auth_update",
                "state": {
                    "providerId": "openrouter",
                    "name": "OpenRouter",
                    "authenticated": True,
                    "available": True,
                    "disabled": False,
                    "credentialOrigin": "api_key",
                    "methods": [
                        {"method": "api_key", "available": True, "exclusive": True},
                        {
                            "method": "future_method",
                            "available": True,
                            "exclusive": True,
                        },
                    ],
                },
            }
        )
        self.assertIsInstance(update, ProviderAuthUpdate)
        self.assertEqual(update.state.methods[1].method, "future_method")
        self.assertFalse(hasattr(update.state, "key"))

    def test_parse_tool_inventory_minimal_and_open_source_kind(self) -> None:
        inventory = parse_tool_inventory(
            {
                "applicationApiVersion": 3,
                "tools": [
                    {
                        "name": "future",
                        "label": "Future",
                        "description": "",
                        "parameters": {},
                        "presentation": "registered",
                        "loadMode": "essential",
                        "source": {"kind": "future_kind"},
                    }
                ],
                "xdev": {"prefix": "xd://", "mountedCount": 0},
            }
        )
        entry = inventory.tools[0]
        self.assertEqual(entry.source.kind, "future_kind")
        self.assertIsNone(entry.summary)
        self.assertIsNone(entry.hidden)
        self.assertIsNone(entry.deferrable)
        self.assertIsNone(entry.strict)
        self.assertIsNone(entry.custom_wire_name)

    def test_parse_tool_inventory_rejects_invalid_counts_and_enums(self) -> None:
        base = {
            "applicationApiVersion": 2,
            "tools": [],
            "xdev": {"prefix": "xd://", "mountedCount": 0},
        }
        with self.assertRaisesRegex(ValueError, "applicationApiVersion"):
            parse_tool_inventory({**base, "applicationApiVersion": True})
        with self.assertRaisesRegex(ValueError, "mountedCount"):
            parse_tool_inventory(
                {**base, "xdev": {"prefix": "xd://", "mountedCount": True}}
            )
        invalid_entry = {
            "name": "bad",
            "label": "Bad",
            "description": "",
            "parameters": {},
            "presentation": "future",
            "loadMode": "essential",
            "source": {"kind": "custom"},
        }
        with self.assertRaisesRegex(ValueError, "presentation"):
            parse_tool_inventory({**base, "tools": [invalid_entry]})

    def test_parse_tool_inventory_update_notification(self) -> None:
        event = parse_notification({"type": "tool_inventory_update", "future": True})
        self.assertIsInstance(event, ToolInventoryUpdateEvent)

    def test_parse_tool_activation_result_available_and_unavailable(self) -> None:
        available = parse_tool_activation_result(
            {
                "enabledToolNames": ["read", "mcp__server_tool"],
                "activeToolNames": ["read"],
                "mountedToolNames": ["mcp__server_tool"],
                "activated": ["mcp__server_tool"],
                "deactivated": [],
                "inventoryAvailable": True,
                "inventory": {
                    "applicationApiVersion": 2,
                    "tools": [],
                    "xdev": {"prefix": "xd://", "mountedCount": 1},
                    "futureInventoryField": True,
                },
                "futureResultField": {"safeToIgnore": True},
            }
        )
        self.assertIsInstance(available, ToolActivationResult)
        self.assertEqual(available.enabled_tool_names, ("read", "mcp__server_tool"))
        self.assertEqual(available.mounted_tool_names, ("mcp__server_tool",))
        self.assertEqual(available.activated, ("mcp__server_tool",))
        self.assertEqual(available.deactivated, ())
        self.assertEqual(available.inventory.application_api_version, 2)

        unavailable = parse_tool_activation_result(
            {
                "enabledToolNames": ["read"],
                "activeToolNames": ["read"],
                "mountedToolNames": [],
                "activated": [],
                "deactivated": ["mcp__server_tool"],
                "inventoryAvailable": False,
                "futureResultField": True,
            }
        )
        self.assertFalse(unavailable.inventory_available)
        self.assertIsNone(unavailable.inventory)

    def test_parse_advertised_notifications_into_typed_events(self) -> None:
        events = [
            parse_notification(
                {
                    "type": "subagent_lifecycle",
                    "payload": {
                        "id": "AgentA",
                        "agent": "reviewer",
                        "agentSource": "bundled",
                        "status": "started",
                        "index": 0,
                        "sessionFile": "/tmp/agent.jsonl",
                    },
                }
            ),
            parse_notification(
                {
                    "type": "subagent_progress",
                    "payload": {
                        "index": 0,
                        "agent": "reviewer",
                        "agentSource": "bundled",
                        "task": "Review",
                        "progress": {
                            "index": 0,
                            "id": "AgentA",
                            "agent": "reviewer",
                            "agentSource": "bundled",
                            "status": "running",
                            "task": "Review",
                            "recentTools": [
                                {"tool": "read", "args": "protocol.py", "endMs": 5}
                            ],
                            "recentOutput": ["Checking parser"],
                            "toolCount": 1,
                            "requests": 1,
                            "tokens": 100,
                            "cost": 0.01,
                            "durationMs": 10,
                            "modelOverride": ["anthropic/claude-sonnet-4-6", "auto"],
                            "extractedToolData": {
                                "read": [{"path": "protocol.py", "line": 1083}]
                            },
                        },
                    },
                }
            ),
            parse_notification(
                {
                    "type": "subagent_event",
                    "payload": {
                        "id": "AgentA",
                        "event": {
                            "type": "notice",
                            "level": "info",
                            "message": "working",
                        },
                    },
                }
            ),
        ]

        expected_types = (
            SubagentLifecycleEvent,
            SubagentProgressEvent,
            SubagentEvent,
        )
        for event, expected_type in zip(events, expected_types, strict=True):
            self.assertIsInstance(event, expected_type)
        self.assertEqual(events[1].payload.progress.recent_tools[0].end_ms, 5.0)
        self.assertEqual(
            events[1].payload.progress.model_override,
            ("anthropic/claude-sonnet-4-6", "auto"),
        )
        self.assertEqual(
            events[1].payload.progress.extracted_tool_data,
            {"read": [{"path": "protocol.py", "line": 1083}]},
        )

    def test_parse_queue_and_job_updates_into_typed_models(self) -> None:
        queue = parse_notification(
            {
                "type": "queue_update",
                "queue": {
                    "steering": [
                        {
                            "entryId": "queue-1",
                            "lane": "steering",
                            "text": "Review",
                            "operationId": "operation-1",
                        }
                    ],
                    "followUp": [],
                    "rowCount": 1,
                    "displayableCount": 1,
                    "pendingCount": 1,
                    "pendingNextTurnCount": 0,
                    "future": True,
                },
                "futureTopLevel": True,
            }
        )
        jobs = parse_notification(
            {
                "type": "job_update",
                "jobs": [
                    {
                        "id": "job-1",
                        "type": "task",
                        "status": "running",
                        "label": "Review",
                        "durationMs": 12,
                        "future": True,
                    }
                ],
                "agents": [
                    {
                        "id": "AgentA",
                        "parentId": "Main",
                        "activity": "Reading",
                        "ageMs": 25,
                    }
                ],
                "futureTopLevel": True,
            }
        )
        self.assertIsInstance(queue, QueueUpdateEvent)
        self.assertEqual(queue.queue.steering[0].entry_id, "queue-1")
        self.assertEqual(queue.queue.pending_count, 1)
        self.assertIsInstance(jobs, JobUpdateEvent)
        self.assertEqual(jobs.jobs[0].id, "job-1")
        self.assertEqual(jobs.jobs[0].duration_ms, 12.0)
        self.assertEqual(jobs.agents[0].parent_id, "Main")

        with self.assertRaisesRegex(ValueError, "displayableCount"):
            parse_notification(
                {
                    "type": "queue_update",
                    "queue": {
                        "steering": [],
                        "followUp": [],
                        "rowCount": 0,
                        "pendingCount": 0,
                        "pendingNextTurnCount": 0,
                    },
                }
            )


if __name__ == "__main__":
    unittest.main()
