"use client";

import { useEffect, useRef, useState } from "react";

export interface TellerEnrollment {
  accessToken: string;
  user: { id: string };
  enrollment: { id: string; institution?: { name?: string | null } | null };
  signatures: string[];
}

interface TellerConnectConfig {
  applicationId: string;
  environment: "sandbox" | "development" | "production";
  products: string[];
  nonce: string;
  enrollmentId?: string;
  onSuccess: (enrollment: TellerEnrollment) => void;
  onExit?: () => void;
  onFailure?: (failure: { message?: string }) => void;
}

interface TellerConnectInstance {
  open(): void;
}

declare global {
  interface Window {
    TellerConnect?: {
      setup(config: TellerConnectConfig): TellerConnectInstance;
    };
  }
}

function loadTellerScript(): Promise<void> {
  if (window.TellerConnect) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-aubrieta-teller-connect="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load Teller Connect.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.teller.io/connect/connect.js";
    script.dataset.aubrietaTellerConnect = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Teller Connect."));
    document.body.appendChild(script);
  });
}

export function TellerConnectLauncher({
  config,
  onSuccess,
  onExit,
  onError,
}: {
  config: {
    applicationId: string;
    environment: "sandbox" | "development" | "production";
    products: string[];
    nonce: string;
    enrollmentId: string | null;
  };
  onSuccess: (enrollment: TellerEnrollment) => void | Promise<void>;
  onExit?: () => void;
  onError?: (message: string) => void;
}) {
  const opened = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    let cancelled = false;
    loadTellerScript()
      .then(() => {
        if (cancelled || !window.TellerConnect) return;
        const instance = window.TellerConnect.setup({
          applicationId: config.applicationId,
          environment: config.environment,
          products: config.products,
          nonce: config.nonce,
          ...(config.enrollmentId ? { enrollmentId: config.enrollmentId } : {}),
          onSuccess: (enrollment) => void onSuccess(enrollment),
          onExit,
          onFailure: (failure) => {
            const message = failure?.message || "Teller Connect failed.";
            setFailed(message);
            onError?.(message);
          },
        });
        instance.open();
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : "Could not open Teller Connect.";
        setFailed(message);
        onError?.(message);
      });
    return () => {
      cancelled = true;
    };
  }, [config, onError, onExit, onSuccess]);

  return failed ? <p className="mt-2 text-sm text-danger">{failed}</p> : null;
}
