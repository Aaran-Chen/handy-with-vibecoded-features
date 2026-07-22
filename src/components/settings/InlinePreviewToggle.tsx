import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface InlinePreviewToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const InlinePreviewToggle: React.FC<InlinePreviewToggleProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("inline_preview") ?? true;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(value) => updateSetting("inline_preview", value)}
        isUpdating={isUpdating("inline_preview")}
        label={t("settings.inlinePreview.label")}
        description={t("settings.inlinePreview.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  });
