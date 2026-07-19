import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Check, Cpu, Download, Gauge, Loader2, Zap } from "lucide-react";
import {
  commands,
  type PostProcessCatalogModel,
  type SystemCapability,
} from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { recommendModels } from "@/lib/utils/recommend";
import { Button } from "@/components/ui/Button";

interface PullProgress {
  model: string;
  status: string;
  completed: number;
  total: number;
  percentage: number;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export const PostProcessModelsSection: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, setPostProcessProvider, updatePostProcessModel } =
    useSettings();

  const [catalog, setCatalog] = useState<PostProcessCatalogModel[]>([]);
  const [capability, setCapability] = useState<SystemCapability | null>(null);
  const [progress, setProgress] = useState<Record<string, PullProgress>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const providerId = getSetting("post_process_provider_id");
  const activeModel = getSetting("post_process_models")?.custom;
  const isOllama = providerId === "custom";

  const refreshCatalog = async () => {
    const res = await commands.getPostProcessModelCatalog();
    if (res.status === "ok") setCatalog(res.data);
  };

  useEffect(() => {
    commands.getSystemCapability().then((res) => {
      if (res.status === "ok") setCapability(res.data);
    });
    refreshCatalog();

    const unlisten = [
      listen<PullProgress>("pp-model-download-progress", (e) => {
        setProgress((p) => ({ ...p, [e.payload.model]: e.payload }));
      }),
      listen<string>("pp-model-download-complete", (e) => {
        setProgress((p) => {
          const next = { ...p };
          delete next[e.payload];
          return next;
        });
        refreshCatalog();
        toast.success(
          t("settings.models.postProcess.downloaded", { model: e.payload }),
        );
      }),
      listen<{ model: string; error: string }>(
        "pp-model-download-failed",
        (e) => {
          setProgress((p) => {
            const next = { ...p };
            delete next[e.payload.model];
            return next;
          });
          toast.error(e.payload.error);
        },
      ),
    ];
    return () => {
      unlisten.forEach((u) => u.then((fn) => fn()));
    };
  }, []);

  const recs = useMemo(
    () =>
      recommendModels(
        catalog.map((m) => ({
          id: m.id,
          speedScore: m.speed_score,
          accuracyScore: m.accuracy_score,
          vramNeedMb: m.vram_need_mb,
        })),
        capability,
      ),
    [catalog, capability],
  );

  const sorted = useMemo(() => {
    return [...catalog].sort((a, b) => {
      const aActive = isOllama && a.id === activeModel ? 1 : 0;
      const bActive = isOllama && b.id === activeModel ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      if (a.is_installed !== b.is_installed) return a.is_installed ? -1 : 1;
      return b.accuracy_score - a.accuracy_score;
    });
  }, [catalog, activeModel, isOllama]);

  const handleSelect = async (id: string) => {
    setBusyId(id);
    try {
      await setPostProcessProvider("custom");
      await updatePostProcessModel("custom", id);
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (id: string) => {
    setProgress((p) => ({
      ...p,
      [id]: {
        model: id,
        status: "starting",
        completed: 0,
        total: 0,
        percentage: 0,
      },
    }));
    const res = await commands.pullPostProcessModel(id);
    if (res.status === "error") {
      setProgress((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
      toast.error(res.error);
    }
  };

  const budgetMb =
    capability && capability.has_gpu && capability.vram_mb > 0
      ? capability.vram_mb
      : capability
        ? Math.floor(capability.ram_mb * 0.5)
        : 0;

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-text/60">
          {t("settings.models.postProcess.title")}
        </h2>
        <p className="text-xs text-text/50 mt-1">
          {capability
            ? t("settings.models.postProcess.machineLine", {
                hardware: capability.has_gpu
                  ? `${gb(capability.vram_mb)} GPU`
                  : `${gb(capability.ram_mb)} RAM`,
              })
            : t("settings.models.postProcess.description")}
        </p>
      </div>

      {!isOllama && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-text/70">
          {t("settings.models.postProcess.notOllama")}
        </div>
      )}

      {sorted.map((m) => {
        const isActive = isOllama && m.id === activeModel;
        const prog = progress[m.id];
        const isDownloading = !!prog;
        const isMachine = recs.machine === m.id;
        const isSpeed = recs.speed === m.id;
        const isAccuracy = recs.accuracy === m.id;
        const tooBig = budgetMb > 0 && m.vram_need_mb > budgetMb;

        return (
          <div
            key={m.id}
            className={`p-4 rounded-lg border transition-colors ${
              isActive
                ? "border-logo-primary bg-logo-primary/5"
                : "border-mid-gray/40 bg-mid-gray/5"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{m.name}</span>
                  <span className="text-xs text-text/50">{m.params}</span>
                  {isMachine && (
                    <Badge tone="primary" icon={<Cpu className="w-3 h-3" />}>
                      {t("settings.models.postProcess.badgeMachine")}
                    </Badge>
                  )}
                  {isSpeed && (
                    <Badge tone="green" icon={<Zap className="w-3 h-3" />}>
                      {t("settings.models.postProcess.badgeSpeed")}
                    </Badge>
                  )}
                  {isAccuracy && (
                    <Badge tone="purple" icon={<Gauge className="w-3 h-3" />}>
                      {t("settings.models.postProcess.badgeAccuracy")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-text/60 mt-1">{m.description}</p>
                <p className="text-xs text-text/40 mt-1">
                  {gb(m.size_mb)}
                  {tooBig
                    ? ` · ${t("settings.models.postProcess.mayBeSlow")}`
                    : ""}
                </p>
              </div>

              <div className="shrink-0">
                {isDownloading ? (
                  <div className="w-32">
                    <div className="h-2 bg-mid-gray/20 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-logo-primary transition-all"
                        style={{ width: `${Math.round(prog.percentage)}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-text/50 mt-1 text-center">
                      {prog.total > 0
                        ? `${Math.round(prog.percentage)}%`
                        : t("settings.models.postProcess.starting")}
                    </div>
                  </div>
                ) : isActive ? (
                  <span className="flex items-center gap-1 text-xs font-medium text-logo-primary">
                    <Check className="w-4 h-4" />
                    {t("settings.models.postProcess.active")}
                  </span>
                ) : m.is_installed ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busyId === m.id}
                    onClick={() => handleSelect(m.id)}
                  >
                    {busyId === m.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      t("settings.models.postProcess.use")
                    )}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!isOllama}
                    onClick={() => handleDownload(m.id)}
                  >
                    <Download className="w-4 h-4 mr-1" />
                    {t("settings.models.postProcess.download")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const Badge: React.FC<{
  tone: "primary" | "green" | "purple";
  icon: React.ReactNode;
  children: React.ReactNode;
}> = ({ tone, icon, children }) => {
  const cls =
    tone === "primary"
      ? "bg-logo-primary/15 text-logo-primary"
      : tone === "green"
        ? "bg-green-500/15 text-green-600 dark:text-green-400"
        : "bg-purple-500/15 text-purple-600 dark:text-purple-400";
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${cls}`}
    >
      {icon}
      {children}
    </span>
  );
};
