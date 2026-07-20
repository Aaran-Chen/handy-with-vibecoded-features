import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ChevronDown, RefreshCcw, Trash2 } from "lucide-react";
import { commands, type TonePreset, type ToneRule } from "@/bindings";

import { Alert } from "../../ui/Alert";
import {
  Dropdown,
  SettingContainer,
  SettingsGroup,
  Textarea,
} from "@/components/ui";
import { Button } from "../../ui/Button";
import { ResetButton } from "../../ui/ResetButton";
import { Input } from "../../ui/Input";

import { ProviderSelect } from "../PostProcessingSettingsApi/ProviderSelect";
import { BaseUrlField } from "../PostProcessingSettingsApi/BaseUrlField";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import { usePostProcessProviderState } from "../PostProcessingSettingsApi/usePostProcessProviderState";
import { ShortcutInput } from "../ShortcutInput";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

const PostProcessingSettingsApiComponent: React.FC = () => {
  const { t } = useTranslation();
  const state = usePostProcessProviderState();

  return (
    <>
      <SettingContainer
        title={t("settings.postProcessing.api.provider.title")}
        description={t("settings.postProcessing.api.provider.description")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <div className="flex items-center gap-2">
          <ProviderSelect
            options={state.providerOptions}
            value={state.selectedProviderId}
            onChange={state.handleProviderSelect}
          />
        </div>
      </SettingContainer>

      {state.isAppleProvider ? (
        state.appleIntelligenceUnavailable ? (
          <Alert variant="error" contained>
            {t("settings.postProcessing.api.appleIntelligence.unavailable")}
          </Alert>
        ) : null
      ) : (
        <>
          {state.selectedProvider?.id === "custom" && (
            <SettingContainer
              title={t("settings.postProcessing.api.baseUrl.title")}
              description={t("settings.postProcessing.api.baseUrl.description")}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              <div className="flex items-center gap-2">
                <BaseUrlField
                  value={state.baseUrl}
                  onBlur={state.handleBaseUrlChange}
                  placeholder={t(
                    "settings.postProcessing.api.baseUrl.placeholder",
                  )}
                  disabled={state.isBaseUrlUpdating}
                  className="min-w-[380px]"
                />
              </div>
            </SettingContainer>
          )}

          <SettingContainer
            title={t("settings.postProcessing.api.apiKey.title")}
            description={t("settings.postProcessing.api.apiKey.description")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <div className="flex items-center gap-2">
              <ApiKeyField
                value={state.apiKey}
                onBlur={state.handleApiKeyChange}
                placeholder={t(
                  "settings.postProcessing.api.apiKey.placeholder",
                )}
                disabled={state.isApiKeyUpdating}
                className="min-w-[320px]"
              />
            </div>
          </SettingContainer>
        </>
      )}

      {!state.isAppleProvider && (
        <SettingContainer
          title={t("settings.postProcessing.api.model.title")}
          description={
            state.isCustomProvider
              ? t("settings.postProcessing.api.model.descriptionCustom")
              : t("settings.postProcessing.api.model.descriptionDefault")
          }
          descriptionMode="tooltip"
          layout="stacked"
          grouped={true}
        >
          <div className="flex items-center gap-2">
            <ModelSelect
              value={state.model}
              options={state.modelOptions}
              disabled={state.isModelUpdating}
              isLoading={state.isFetchingModels}
              placeholder={
                state.modelOptions.length > 0
                  ? t(
                      "settings.postProcessing.api.model.placeholderWithOptions",
                    )
                  : t("settings.postProcessing.api.model.placeholderNoOptions")
              }
              onSelect={state.handleModelSelect}
              onCreate={state.handleModelCreate}
              onBlur={() => {}}
              className="flex-1 min-w-[380px]"
            />
            <ResetButton
              onClick={state.handleRefreshModels}
              disabled={state.isFetchingModels}
              ariaLabel={t("settings.postProcessing.api.model.refreshModels")}
              className="flex h-10 w-10 items-center justify-center"
            >
              <RefreshCcw
                className={`h-4 w-4 ${state.isFetchingModels ? "animate-spin" : ""}`}
              />
            </ResetButton>
          </div>
        </SettingContainer>
      )}
    </>
  );
};

const PostProcessingSettingsPromptsComponent: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");

  const prompts = getSetting("post_process_prompts") || [];
  const selectedPromptId = getSetting("post_process_selected_prompt_id") || "";
  const selectedPrompt =
    prompts.find((prompt) => prompt.id === selectedPromptId) || null;

  useEffect(() => {
    if (isCreating) return;

    if (selectedPrompt) {
      setDraftName(selectedPrompt.name);
      setDraftText(selectedPrompt.prompt);
    } else {
      setDraftName("");
      setDraftText("");
    }
  }, [
    isCreating,
    selectedPromptId,
    selectedPrompt?.name,
    selectedPrompt?.prompt,
  ]);

  const handlePromptSelect = (promptId: string | null) => {
    if (!promptId) return;
    updateSetting("post_process_selected_prompt_id", promptId);
    setIsCreating(false);
  };

  const handleCreatePrompt = async () => {
    if (!draftName.trim() || !draftText.trim()) return;

    try {
      const result = await commands.addPostProcessPrompt(
        draftName.trim(),
        draftText.trim(),
      );
      if (result.status === "ok") {
        await refreshSettings();
        updateSetting("post_process_selected_prompt_id", result.data.id);
        setIsCreating(false);
      }
    } catch (error) {
      console.error("Failed to create prompt:", error);
    }
  };

  const handleUpdatePrompt = async () => {
    if (!selectedPromptId || !draftName.trim() || !draftText.trim()) return;

    try {
      await commands.updatePostProcessPrompt(
        selectedPromptId,
        draftName.trim(),
        draftText.trim(),
      );
      await refreshSettings();
    } catch (error) {
      console.error("Failed to update prompt:", error);
    }
  };

  const handleDeletePrompt = async (promptId: string) => {
    if (!promptId) return;

    try {
      await commands.deletePostProcessPrompt(promptId);
      await refreshSettings();
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to delete prompt:", error);
    }
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    if (selectedPrompt) {
      setDraftName(selectedPrompt.name);
      setDraftText(selectedPrompt.prompt);
    } else {
      setDraftName("");
      setDraftText("");
    }
  };

  const handleStartCreate = () => {
    setIsCreating(true);
    setDraftName("");
    setDraftText("");
  };

  const hasPrompts = prompts.length > 0;
  const isDirty =
    !!selectedPrompt &&
    (draftName.trim() !== selectedPrompt.name ||
      draftText.trim() !== selectedPrompt.prompt.trim());

  return (
    <SettingContainer
      title={t("settings.postProcessing.prompts.selectedPrompt.title")}
      description={t(
        "settings.postProcessing.prompts.selectedPrompt.description",
      )}
      descriptionMode="tooltip"
      layout="stacked"
      grouped={true}
    >
      <div className="space-y-3">
        <div className="flex gap-2 min-w-0">
          <Dropdown
            selectedValue={selectedPromptId || null}
            options={prompts.map((p) => ({
              value: p.id,
              label: p.name,
            }))}
            onSelect={(value) => handlePromptSelect(value)}
            placeholder={
              prompts.length === 0
                ? t("settings.postProcessing.prompts.noPrompts")
                : t("settings.postProcessing.prompts.selectPrompt")
            }
            disabled={
              isUpdating("post_process_selected_prompt_id") || isCreating
            }
            className="flex-1 min-w-0"
          />
          <Button
            onClick={handleStartCreate}
            variant="primary"
            size="md"
            disabled={isCreating}
            className="shrink-0"
          >
            {t("settings.postProcessing.prompts.createNew")}
          </Button>
        </div>

        {!isCreating && hasPrompts && selectedPrompt && (
          <div className="space-y-3">
            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptLabel")}
              </label>
              <Input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptLabelPlaceholder",
                )}
                variant="compact"
              />
            </div>

            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptInstructions")}
              </label>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptInstructionsPlaceholder",
                )}
              />
              <p className="text-xs text-mid-gray/70">
                <Trans
                  i18nKey="settings.postProcessing.prompts.promptTip"
                  components={{ code: <code /> }}
                />
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleUpdatePrompt}
                variant="primary"
                size="md"
                disabled={!draftName.trim() || !draftText.trim() || !isDirty}
              >
                {t("settings.postProcessing.prompts.updatePrompt")}
              </Button>
              <Button
                onClick={() => handleDeletePrompt(selectedPromptId)}
                variant="secondary"
                size="md"
                disabled={!selectedPromptId || prompts.length <= 1}
              >
                {t("settings.postProcessing.prompts.deletePrompt")}
              </Button>
            </div>
          </div>
        )}

        {!isCreating && !selectedPrompt && (
          <div className="p-3 bg-mid-gray/5 rounded-md border border-mid-gray/20">
            <p className="text-sm text-mid-gray">
              {hasPrompts
                ? t("settings.postProcessing.prompts.selectToEdit")
                : t("settings.postProcessing.prompts.createFirst")}
            </p>
          </div>
        )}

        {isCreating && (
          <div className="space-y-3">
            <div className="space-y-2 block flex flex-col">
              <label className="text-sm font-semibold text-text">
                {t("settings.postProcessing.prompts.promptLabel")}
              </label>
              <Input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptLabelPlaceholder",
                )}
                variant="compact"
              />
            </div>

            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptInstructions")}
              </label>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptInstructionsPlaceholder",
                )}
              />
              <p className="text-xs text-mid-gray/70">
                <Trans
                  i18nKey="settings.postProcessing.prompts.promptTip"
                  components={{ code: <code /> }}
                />
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleCreatePrompt}
                variant="primary"
                size="md"
                disabled={!draftName.trim() || !draftText.trim()}
              >
                {t("settings.postProcessing.prompts.createPrompt")}
              </Button>
              <Button
                onClick={handleCancelCreate}
                variant="secondary"
                size="md"
              >
                {t("settings.postProcessing.prompts.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingContainer>
  );
};

const ContextAwarenessComponent: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const enabled = getSetting("context_aware_enabled") ?? true;
  const savedRules = getSetting("context_tone_rules") || [];
  const savedPresets = getSetting("tone_presets") || [];
  const [draftRules, setDraftRules] = useState<ToneRule[]>(savedRules);
  const [draftPresets, setDraftPresets] = useState<TonePreset[]>(savedPresets);
  const [expandedPresetId, setExpandedPresetId] = useState<string | null>(null);
  // True while an input holds uncommitted keystrokes (committed onBlur).
  const dirtyRef = React.useRef(false);
  const presetsDirtyRef = React.useRef(false);

  // Adopt external changes (initial load, backend refresh) — but never while
  // the user has uncommitted typing, which the refresh would silently wipe.
  const savedKey = JSON.stringify(savedRules);
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraftRules(JSON.parse(savedKey));
  }, [savedKey]);

  const savedPresetsKey = JSON.stringify(savedPresets);
  useEffect(() => {
    if (presetsDirtyRef.current) return;
    setDraftPresets(JSON.parse(savedPresetsKey));
  }, [savedPresetsKey]);

  const presetIds = React.useMemo(
    () => new Set(draftPresets.map((p) => p.id)),
    [draftPresets],
  );

  const commitRules = (rules: ToneRule[]) => {
    dirtyRef.current = false;
    updateSetting("context_tone_rules", rules);
  };

  const commitPresets = (presets: TonePreset[]) => {
    presetsDirtyRef.current = false;
    updateSetting("tone_presets", presets);
  };

  const handlePresetInstructionChange = (index: number, value: string) => {
    presetsDirtyRef.current = true;
    setDraftPresets((presets) =>
      presets.map((p, i) => (i === index ? { ...p, instruction: value } : p)),
    );
  };

  const handleRuleChange = (
    index: number,
    field: "pattern" | "tone",
    value: string,
  ) => {
    dirtyRef.current = true;
    setDraftRules((rules) =>
      rules.map((rule, i) =>
        i === index ? { ...rule, [field]: value } : rule,
      ),
    );
  };

  const handleAddRule = () => {
    const next = [
      ...draftRules,
      { id: crypto.randomUUID(), pattern: "", tone: "casual" },
    ];
    setDraftRules(next);
    commitRules(next);
  };

  const handleRemoveRule = (index: number) => {
    const next = draftRules.filter((_, i) => i !== index);
    setDraftRules(next);
    commitRules(next);
  };

  return (
    <>
      <ToggleSwitch
        checked={enabled}
        onChange={(value) => updateSetting("context_aware_enabled", value)}
        isUpdating={isUpdating("context_aware_enabled")}
        label={t("settings.postProcessing.context.toggle.label")}
        description={t("settings.postProcessing.context.toggle.description")}
        descriptionMode="tooltip"
        grouped={true}
      />

      {enabled && (
        <SettingContainer
          title={t("settings.postProcessing.context.rules.title")}
          description={t("settings.postProcessing.context.rules.description")}
          descriptionMode="tooltip"
          layout="stacked"
          grouped={true}
        >
          <div className="space-y-2">
            {draftRules.length === 0 && (
              <p className="text-sm text-mid-gray">
                {t("settings.postProcessing.context.rules.empty")}
              </p>
            )}
            {draftRules.map((rule, index) => {
              const isCustomTone = !presetIds.has(rule.tone);
              return (
                <div key={rule.id} className="flex gap-2 items-center min-w-0">
                  <Input
                    type="text"
                    value={rule.pattern}
                    onChange={(e) =>
                      handleRuleChange(index, "pattern", e.target.value)
                    }
                    onBlur={() => commitRules(draftRules)}
                    placeholder={t(
                      "settings.postProcessing.context.rules.patternPlaceholder",
                    )}
                    variant="compact"
                    className="flex-1 min-w-0"
                  />
                  <Dropdown
                    selectedValue={isCustomTone ? "__custom__" : rule.tone}
                    options={[
                      ...draftPresets.map((p) => ({
                        value: p.id,
                        label: p.name,
                      })),
                      {
                        value: "__custom__",
                        label: t(
                          "settings.postProcessing.context.rules.customTone",
                        ),
                      },
                    ]}
                    onSelect={(value) => {
                      if (!value) return;
                      const next = draftRules.map((r, i) =>
                        i === index
                          ? { ...r, tone: value === "__custom__" ? "" : value }
                          : r,
                      );
                      setDraftRules(next);
                      commitRules(next);
                    }}
                    className="w-40 shrink-0"
                  />
                  {isCustomTone && (
                    <Input
                      type="text"
                      value={rule.tone}
                      onChange={(e) =>
                        handleRuleChange(index, "tone", e.target.value)
                      }
                      onBlur={() => commitRules(draftRules)}
                      placeholder={t(
                        "settings.postProcessing.context.rules.tonePlaceholder",
                      )}
                      variant="compact"
                      className="flex-1 min-w-0"
                    />
                  )}
                  <Button
                    onClick={() => handleRemoveRule(index)}
                    variant="secondary"
                    size="md"
                    className="shrink-0"
                    aria-label={t(
                      "settings.postProcessing.context.rules.remove",
                    )}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
            <Button onClick={handleAddRule} variant="primary" size="md">
              {t("settings.postProcessing.context.rules.add")}
            </Button>
          </div>
        </SettingContainer>
      )}

      {enabled && (
        <SettingContainer
          title={t("settings.postProcessing.context.presets.title")}
          description={t("settings.postProcessing.context.presets.description")}
          descriptionMode="tooltip"
          layout="stacked"
          grouped={true}
        >
          <div className="space-y-2">
            {draftPresets.map((preset, index) => {
              const expanded = expandedPresetId === preset.id;
              return (
                <div
                  key={preset.id}
                  className="rounded-lg border border-mid-gray/30 overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedPresetId(expanded ? null : preset.id)
                    }
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-mid-gray/10 transition-colors"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {preset.name}
                      </span>
                      {!expanded && (
                        <span className="block text-xs text-text/50 truncate">
                          {preset.instruction}
                        </span>
                      )}
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 shrink-0 text-text/50 transition-transform ${
                        expanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {expanded && (
                    <div className="px-3 pb-3">
                      <Textarea
                        value={preset.instruction}
                        onChange={(e) =>
                          handlePresetInstructionChange(index, e.target.value)
                        }
                        onBlur={() => commitPresets(draftPresets)}
                        rows={4}
                      />
                      <p className="mt-1 text-xs text-text/50">
                        {t(
                          "settings.postProcessing.context.presets.editorHint",
                        )}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SettingContainer>
      )}
    </>
  );
};

export const ContextAwarenessSettings = React.memo(ContextAwarenessComponent);
ContextAwarenessSettings.displayName = "ContextAwarenessSettings";

const AutomaticPostProcessToggleComponent: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const enabled = getSetting("always_post_process") ?? false;

  return (
    <ToggleSwitch
      checked={enabled}
      onChange={(value) => updateSetting("always_post_process", value)}
      isUpdating={isUpdating("always_post_process")}
      label={t("settings.postProcessing.automatic.toggle.label")}
      description={t("settings.postProcessing.automatic.toggle.description")}
      descriptionMode="tooltip"
      grouped={true}
    />
  );
};

export const AutomaticPostProcessToggle = React.memo(
  AutomaticPostProcessToggleComponent,
);
AutomaticPostProcessToggle.displayName = "AutomaticPostProcessToggle";

export const PostProcessingSettingsApi = React.memo(
  PostProcessingSettingsApiComponent,
);
PostProcessingSettingsApi.displayName = "PostProcessingSettingsApi";

export const PostProcessingSettingsPrompts = React.memo(
  PostProcessingSettingsPromptsComponent,
);
PostProcessingSettingsPrompts.displayName = "PostProcessingSettingsPrompts";

export const PostProcessingSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.postProcessing.hotkey.title")}>
        <ShortcutInput
          shortcutId="transcribe_with_post_process"
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.postProcessing.automatic.title")}>
        <AutomaticPostProcessToggle />
      </SettingsGroup>

      <SettingsGroup title={t("settings.postProcessing.api.title")}>
        <PostProcessingSettingsApi />
      </SettingsGroup>

      <SettingsGroup title={t("settings.postProcessing.prompts.title")}>
        <PostProcessingSettingsPrompts />
      </SettingsGroup>

      <SettingsGroup title={t("settings.postProcessing.context.title")}>
        <ContextAwarenessSettings />
      </SettingsGroup>
    </div>
  );
};
