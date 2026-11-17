/**
 * regionConfig.ts — Region definitions and spatial geometries for GEORE.
 */

export interface RegionConfig {
  name: string;
  lat: number;
  lon: number;
  buffer_meters: number;
  avg_slope_degrees: number;
  historical_susceptibility: number;
}

export const REGIONS: Record<string, RegionConfig> = {
  "NP-KTM-01": {
    name: "Kathmandu Valley, Nepal",
    lat: 27.7172,
    lon: 85.324,
    buffer_meters: 2500,
    avg_slope_degrees: 35.0,
    historical_susceptibility: 0.8,
  },
  "NP-POK-02": {
    name: "Pokhara Valley, Nepal",
    lat: 28.2096,
    lon: 83.9856,
    buffer_meters: 3000,
    avg_slope_degrees: 28.0,
    historical_susceptibility: 0.65,
  },
};

export function getRegionConfig(regionId: string): RegionConfig {
  if (regionId in REGIONS) {
    return REGIONS[regionId];
  }
  return {
    ...REGIONS["NP-KTM-01"],
    name: `Unknown Region (${regionId})`,
  };
}
