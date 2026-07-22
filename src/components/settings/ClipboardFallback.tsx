import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface ClipboardFallbackProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const ClipboardFallback: React.FC<ClipboardFallbackProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("clipboard_fallback") ?? true;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(enabled) => updateSetting("clipboard_fallback", enabled)}
        isUpdating={isUpdating("clipboard_fallback")}
        label={t("settings.debug.clipboardFallback.label")}
        description={t("settings.debug.clipboardFallback.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);
