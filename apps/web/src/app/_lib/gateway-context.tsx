"use client";

import { createContext, type ReactNode, useContext } from "react";
import { apiGateway } from "./api-gateway";
import type { OnboardingGateway } from "./onboarding-gateway";

const GatewayContext = createContext<OnboardingGateway>(apiGateway);

/** Supplies the gateway to the screens; the real API gateway unless a showcase passes the demo one. */
export function GatewayProvider({
  gateway = apiGateway,
  children,
}: {
  gateway?: OnboardingGateway;
  children: ReactNode;
}) {
  return <GatewayContext.Provider value={gateway}>{children}</GatewayContext.Provider>;
}

export function useGateway(): OnboardingGateway {
  return useContext(GatewayContext);
}
