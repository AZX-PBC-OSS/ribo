/**
 * @file Example source texts for the dev-only "Try it" extraction panel.
 *
 * These are three of the SnuggPro spike transcripts (`spikes/extraction-snuggpro/
 * transcripts/`), copied here as string literals. They cannot be imported across
 * the bundle boundary from `spikes/` (outside the workspace build), so they are
 * duplicated — a copy is the honest way to ship them into the browser bundle.
 *
 * Each is a home-energy auditor narrating a walkthrough; between them they cover a
 * spoken R-value + a clean CO test (01), a long everything-at-once walkthrough with
 * a spillage FAIL and a retraction trap (05), and a case where the auditor
 * explicitly declines to state the heating fuel (08) — the "silent fuel drop" the
 * extractor must render as `null`, not invent.
 */

export interface TranscriptExample {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

const ATTIC_R_VALUE_SHELL = `Okay, recording. Twenty-two Linden Street, the Okafor place, starting up in the attic and I'll work down.

Attic access is through the bedroom closet, tight squeeze. Insulation up here is blown fiberglass, kind of pinkish, laying between and over the joists, pretty even coverage. I'd put it at about R-38 up here, that's a decent attic, R-38. No gaps except right around the chimney chase where somebody left it open, I'll note that.

Heat's a gas furnace down in the utility closet, forced hot air, it's a Trane. Model number off the label — it's a TUD100, and the manufacture date stamped is twenty seventeen. Output's a hundred thousand BTU on the plate. Fired it up, runs fine.

Ambient CO right next to the furnace while it was running read zero, so that's clean, no carbon monoxide, good.

Blower door, I set it in the side door. We came in at thirty-two hundred CFM50. Thirty-two hundred.

Windows are all double pane, vinyl frames, looks like they were done all at once. Whole house double pane vinyl.

Walls — I didn't open anything up, it's brick veneer, I'd have to drill and I'm not doing that today, so I can't tell you on the wall insulation. Leaving that one blank.

That's what I've got. Ending.`;

const FULL_WALKTHROUGH = `Okay, full walkthrough on the Castellano property, forty-one Maple, I'm going to run through the whole thing on one recording so bear with me, there's a lot here and the light's going.

Starting in the mechanical closet off the kitchen. The heating system is a propane furnace, forced air, high-efficiency looking thing, condensing, there's the PVC flue going out the side wall so it's direct-vented, sealed combustion, pulls its air from outside. It's a Carrier, the model number is 59TP6, I'll spell that, five nine T P six, and the data plate year is twenty nineteen. Output capacity is eighty thousand BTU. There's a sticker on it claiming ninety-six percent but I'm not writing efficiency down, that's a lookup, you don't type that.

Now — important, listen to this part — the homeowner's got a quote to swap this out for a heat pump next year, and there's an old floor furnace, a gravity job, sitting disconnected down in the basement, the ancient one they took out of service years ago. That old thing was an oil pot burner, it's decommissioned, capped, cold. I am not logging that as the system. The working system, the one that heats this house today, is the propane Carrier in the closet. Don't let the old oil unit end up in the record.

[homeowner] Do you need the manual for the furnace?

No, I've got what I need off the plate, thanks.

Cooling is central AC, it's got a standalone air handler up in the attic with its own duct runs, condenser outside on a pad. So central AC, standalone ducts. And that ductwork in the attic is leaky, I could feel it, air pouring off the boots, pretty leaky, I'd call it very leaky honestly. I put the duct blaster on it and the duct leakage came in at one-fifty CFM25, a hundred fifty at twenty-five pascals. The ducts are wrapped in that thin fiberglass, the inch-and-a-quarter stuff, not much.

Blower door next, set up in the front door. I got twenty-eight hundred CFM50 on the fan. I worked the house volume so that's about six point one ACH50, but the fan number, the one for the blower door, is twenty-eight hundred CFM50.

Attic, same trip up as the air handler, access in the garage ceiling. It's cellulose up there, blown gray cellulose, and I actually measured the depth with the ruler — I'm getting eleven, twelve inches in the field, call it a good foot of cellulose, a solid eleven, twelve inches. And since the homeowner asked, at that depth it works out to roughly R-38, but understand the depth is what I actually measured, the eleven, twelve inches, the R-value's just the conversion.

Water heater — it's a propane tankless unit, mounted on the wall in the closet, a Rinnai, on-demand, no age tag I could find on it, it's newer though. Tankless.

Health and safety, this is the part that really matters on this house, so pay attention. Ambient CO throughout the house was zero to two ppm, clean, no CO issue anywhere. But — I ran the natural condition spillage test on the water heater, and it spilled, it backdrafted under natural conditions, flue gases rolling right out the draft diverter, and that is a hard fail, a fail on spillage under natural conditions. There's also some moisture staining on the basement wall, efflorescence and a bit of soft drywall in the one corner, I'd flag that as a moisture concern, worth watching, call it a warning on moisture, not a crisis but keep an eye. And there's old pipe wrap on the basement lines that looks like it could be asbestos — I did not test it, I'm not equipped to sample asbestos, so that one is not tested, defer it to an abatement pro.

Windows are a mix but predominantly double pane, and the frames are that wood with the aluminum cladding on the outside, clad windows, wood clad.

Walls, I opened one cavity on the addition, there's fiberglass batt in there, decent, I'd call the walls insulated, yes, properly insulated.

[homeowner] What about the sunroom, is that going to show up cold?

Yeah, the sunroom's a whole separate conversation, that's single-glazed on three sides and basically unconditioned, but it's not on the main envelope so I'm treating it as outside the thermal boundary, I'll footnote it.

That's the whole house. The big items: the spillage fail on the water heater, the leaky attic ducts, and the general air sealing at twenty-eight hundred. Ending recording, that's forty-one Maple.`;

const NO_FUEL_SILENT_DROP = `Second floor and attic on the Petrov place.

Heating's a furnace, forced warm air — up in the attic there's an air handler, no wait, the furnace itself is in the closet and the AC air handler's the separate thing. Let me be clear: heating is a furnace, forced air, I can see the supply plenum coming off it. I honestly did not check the fuel on it, I never got down to the meter or looked for a tank, and I'm not going to guess, so I can't tell you the fuel on this one. It's a Lennox, though, model G-something, I couldn't get the full model number off the corner it was jammed into, and there's no year I could read.

The AC's got its own ducts up in the attic, standalone, separate from anything the furnace does. Central AC, standalone ducts. And the ducts up here have no insulation on them at all, bare metal, and they're loose, one's actually disconnected at a boot, I'd call the sealing very leaky.

Attic insulation is fiberglass batts, and I'd estimate R-thirty, R-30, up here between the joists. That's an R-value — I didn't measure the depth with a ruler, I'm eyeballing the R.

Walls, the upstairs walls, there's some insulation in there but it's really thin, patchy, I pulled a switch plate and it's like a couple inches of old batt sagging in the cavity. So some, but poor.

That's the upstairs. Ending.`;

export const TRANSCRIPT_EXAMPLES: readonly TranscriptExample[] = [
  { id: "attic-r-value-shell", label: "Attic R-value shell", text: ATTIC_R_VALUE_SHELL },
  { id: "full-walkthrough", label: "Full walkthrough", text: FULL_WALKTHROUGH },
  { id: "no-fuel-silent-drop", label: "Silent fuel drop", text: NO_FUEL_SILENT_DROP },
];

/** The prefilled source text — the shortest, most legible example. */
export const DEFAULT_TEXT = ATTIC_R_VALUE_SHELL;
