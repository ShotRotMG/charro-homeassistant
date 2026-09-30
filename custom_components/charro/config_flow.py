"""One-click config flow.

There is nothing to configure — the flow exists so the integration can be
added from Settings → Devices & Services instead of configuration.yaml.
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, PANEL_TITLE


class CharroConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add Charro Cards. Single instance, no options."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is None:
            return self.async_show_form(step_id="user")
        return self.async_create_entry(title=f"Charro Cards ({PANEL_TITLE})", data={})
