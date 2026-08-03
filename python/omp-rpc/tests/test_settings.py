from __future__ import annotations

import unittest
from unittest.mock import patch

from omp_rpc import (
    RpcClient,
    SettingsChange,
    SettingsUpdateEvent,
    parse_notification,
    parse_settings_snapshot,
)

SNAPSHOT = {
    "tabs": [
        {
            "id": "appearance",
            "label": "Appearance",
            "icon": "tab.appearance",
            "groups": ["Status Line"],
            "futureField": True,
        }
    ],
    "settings": [
        {
            "path": "colorBlindMode",
            "type": "boolean",
            "default": False,
            "value": True,
            "configured": True,
            "ui": {
                "tab": "appearance",
                "label": "Color Blind Mode",
                "description": "Use accessible colors",
                "control": "boolean",
                "renderable": True,
            },
            "futureField": "ignored",
        }
    ],
}


class SettingsProtocolTests(unittest.TestCase):
    def test_parses_snapshot_and_pull_only_update(self) -> None:
        snapshot = parse_settings_snapshot(SNAPSHOT)
        self.assertEqual(snapshot.tabs[0].id, "appearance")
        self.assertEqual(snapshot.settings[0].path, "colorBlindMode")
        self.assertIs(snapshot.settings[0].value, True)
        self.assertIsInstance(
            parse_notification({"type": "settings_update"}), SettingsUpdateEvent
        )

    def test_tolerates_older_snapshot_without_optional_entry_fields(self) -> None:
        snapshot = parse_settings_snapshot(
            {
                "tabs": [],
                "settings": [{"path": "colorBlindMode", "type": "boolean"}],
            }
        )
        self.assertIsNone(snapshot.settings[0].value)
        self.assertIsNone(snapshot.settings[0].configured)
        self.assertFalse(snapshot.settings[0].redacted)

    def test_client_methods_use_typed_changes_and_parse_responses(self) -> None:
        client = RpcClient()
        with patch.object(client, "_request", return_value=SNAPSHOT) as request:
            fetched = client.get_settings()
            request.assert_called_once_with("get_settings", tab=None)
            self.assertEqual(fetched.settings[0].value, True)

        with patch.object(client, "_request", return_value=SNAPSHOT) as request:
            updated = client.set_settings(
                [SettingsChange(path="colorBlindMode", value=True)]
            )
            request.assert_called_once_with(
                "set_settings",
                changes=[{"path": "colorBlindMode", "value": True}],
            )
            self.assertEqual(updated.tabs[0].id, "appearance")


if __name__ == "__main__":
    unittest.main()
