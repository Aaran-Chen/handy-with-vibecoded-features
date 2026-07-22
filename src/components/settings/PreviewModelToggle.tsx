import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface PreviewModelToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const PreviewModelToggle: React.FC<PreviewModelToggleProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("preview_model_enabled") ?? false;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(value) => updateSetting("preview_model_enabled", value)}
        isUpdating={isUpdating("preview_model_enabled")}
        label={t("settings.previewModel.label")}
        description={t("settings.previewModel.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);
