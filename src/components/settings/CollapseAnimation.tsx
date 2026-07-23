import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { Slider } from "../ui/Slider";
import { useSettings } from "../../hooks/useSettings";

interface CollapseAnimationProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/**
 * Controls for the stop-collapse animation (preview text pouring into the
 * spinning star). When disabled, the overlay disappears the moment recording
 * stops and the text simply pastes once post-processing finishes.
 */
export const CollapseAnimation: React.FC<CollapseAnimationProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("collapse_animation_enabled") ?? true;
    const speed = getSetting("collapse_animation_speed") ?? 1;

    return (
      <>
        <ToggleSwitch
          checked={enabled}
          onChange={(value) =>
            updateSetting("collapse_animation_enabled", value)
          }
          isUpdating={isUpdating("collapse_animation_enabled")}
          label={t("settings.debug.collapseAnimation.label")}
          description={t("settings.debug.collapseAnimation.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        />
        <Slider
          value={speed}
          onChange={(value) => updateSetting("collapse_animation_speed", value)}
          min={0.5}
          max={1.5}
          step={0.05}
          disabled={!enabled}
          label={t("settings.debug.collapseAnimationSpeed.label")}
          description={t("settings.debug.collapseAnimationSpeed.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
          formatValue={(value) => `${value.toFixed(2)}x`}
        />
      </>
    );
  },
);
