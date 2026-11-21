"use client";

import { createContext, type ReactNode, useContext } from "react";
import { demoGateway, type OnboardingGateway } from "./onboarding-gateway";

const GatewayContext = createContext<OnboardingGateway>(demoGateway);

/** Supplies the gateway to the screens. Pass `gateway` to swap in the real implementation. */
export function GatewayProvider({
  gateway = demoGateway,
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
