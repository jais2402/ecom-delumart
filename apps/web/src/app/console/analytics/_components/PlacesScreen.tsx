"use client";

import { Breadcrumbs, DateRangePicker, PlaceTable, Text } from "@delulu/ui";
import { placeKey, placeLabel } from "../_lib/places";
import { queryString } from "../_lib/range";
import type { PlaceItem, PlaceLevel, PlacesResponse } from "../_lib/types";
import { useAdminQuery } from "../_lib/use-admin-query";
import { useUrlState } from "../_lib/use-url-state";
import { AnalyticsFrame } from "./AnalyticsFrame";
import { Panel } from "./Panel";
import { PeriodNotes } from "./PeriodNotes";

const PATH = "/console/analytics/places";
const HEADERS: Record<PlaceLevel, string> = { country: "Country", region: "Region", city: "City" };
const itemKey = (i: PlaceItem) => `${i.country}|${i.region ?? ""}|${i.city ?? ""}`;

/** /console/analytics/places: country, then region, then city. The drill-down is in the URL. */
export function PlacesScreen() {
  const { params, range, today, go } = useUrlState();
  // a level without the places above it falls back to the country list
  const country = params.get("country");
  const region = params.get("region");
  const asked = params.get("level");
  const level: PlaceLevel =
    asked === "city" && country && region ? "city" : asked === "region" && country ? "region" : "country";
  const scope = {
    level,
    country: level === "country" ? null : country,
    region: level === "city" ? region : null,
  };
  const [state, retry] = useAdminQuery<PlacesResponse>(
    `/api/v1/admin/analytics/places?${queryString({ ...scope, from: range.from, to: range.to })}`,
  );
  const dates = { from: range.from, to: range.to };

  const here = (v: Record<string, string | null>) => `${PATH}?${queryString({ ...v, ...dates })}`;
  const countryText = country
    ? placeLabel({ country, region: null, city: null, visitors: 0, signUps: 0, purchases: 0 }, "country")
    : "";
  // the last crumb is the current level and is not a link
  const crumbs: { label: string; href?: string }[] = [{ label: "All countries", href: here({}) }];
  if (level !== "country" && country)
    crumbs.push({ label: countryText, href: here({ level: "region", country }) });
  if (level === "city" && region) crumbs.push({ label: region });
  const last = crumbs[crumbs.length - 1];
  if (last) delete last.href;

  return (
    <AnalyticsFrame current={PATH} title="Usage by place" states={[state]}>
      <DateRangePicker
        today={today}
        from={range.from}
        to={range.to}
        onChange={(next) => go({ ...scope, from: next.from, to: next.to })}
      />
      <Breadcrumbs items={crumbs} />
      <Panel
        title={`Usage by ${HEADERS[level].toLowerCase()}`}
        hint="Visitors are daily visitors, summed over the period. Open a row to see the places inside it."
        state={state}
        retry={retry}
        isEmpty={(data) => data.items.length === 0}
      >
        {(data) => (
          <div className="flex flex-col gap-3">
            <PeriodNotes
              from={data.from}
              to={data.to}
              days={data.days}
              trafficDays={data.trafficDays}
              asOf={data.asOf}
            />
            <PlaceTable
              caption={`Usage by ${HEADERS[level].toLowerCase()}`}
              placeHeader={HEADERS[level]}
              rows={data.items.map((item) => ({
                key: itemKey(item),
                label: placeLabel(item, level),
                visitors: item.visitors,
                signUps: item.signUps,
                purchases: item.purchases,
                drillable: placeKey(item, level) !== null,
              }))}
              drillLabel={(row) => `Show ${level === "country" ? "regions" : "cities"} in ${row.label}`}
              onDrill={(row) => {
                const item = data.items.find((i) => itemKey(i) === row.key);
                if (!item) return;
                if (level === "country") go({ level: "region", country: item.country, ...dates });
                else if (level === "region" && item.region)
                  go({ level: "city", country: country ?? item.country, region: item.region, ...dates });
              }}
            />
            <Text size="sm" muted>
              {`Places with fewer than ${data.minVisitors} daily visitors are combined into "Other (small places combined)" to protect privacy. Unknown places are shown as "Unknown".`}
            </Text>
          </div>
        )}
      </Panel>
    </AnalyticsFrame>
  );
}
