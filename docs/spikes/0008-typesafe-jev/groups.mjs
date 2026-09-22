// The five resource groups the annotated corpus covers, described by their REAL leaf names
// from packages/ribo-adapter-snuggpro/src/schema.ts — nothing here is invented prose.
export const GROUPS = {
  attic: {
    label: "attic",
    leaves: ["atticInsulation", "atticInsulationDepth", "atticInsulationType"],
    blurb: "the attic: its insulation R-value, insulation depth, or insulation material",
  },
  hvac: {
    label: "hvac",
    leaves: [
      "hvacSystemEquipmentType",
      "hvacHeatingEnergySource",
      "hvacHeatingSystemManufacturer",
      "hvacHeatingSystemModel",
      "hvacHeatingSystemModelYear",
      "hvacHeatingCapacity",
      "hvacDuctLocation",
      "hvacDuctInsulation",
      "hvacDuctLeakage",
      "hvacDuctLeakageValue",
      "hvacUpgradeAction",
    ],
    blurb:
      "the heating/cooling system: equipment type, fuel or energy source, manufacturer, model, " +
      "year, capacity, or its ductwork (location, insulation, leakage)",
  },
  wall: {
    label: "wall",
    leaves: ["wallsInsulated", "wallCavityInsulationType", "wallExteriorWallSiding"],
    blurb:
      "the exterior walls: whether they are insulated, the cavity insulation type, or the siding",
  },
  window: {
    label: "window",
    leaves: ["windowType", "windowFrame"],
    blurb: "the windows: their glazing type or their frame material",
  },
  dhw: {
    label: "dhw",
    leaves: ["dhwType2", "dhwFuel2", "dhwManufacturer", "dhwAge", "dhwTankSize", "dhwLocation"],
    blurb:
      "domestic hot water: the water heater's type, fuel, manufacturer, age, tank size, or location",
  },
};

export const GROUP_IDS = Object.keys(GROUPS);
