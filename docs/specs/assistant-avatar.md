# The animated mark: loading indicator and assistant avatar: spec

Status: **implemented** November 7, 2026 as `LogoMark` in
`packages/web/src/ui/logo-mark.tsx`. It is the loading indicator today. The
agent chat that will use it as the assistant's avatar is not built yet.
Open questions are in section 7.

The moods and colors were worked out in a standalone page,
[`assistant-avatar-playground.html`](../research/assistant-avatar-playground.html).
Open it in a browser to try each mood, the chat timing and the light-mode
options that were set aside. It is a design tool, not the shipped code.

## 1. Why

The web app needs two things that move: a loading indicator, and an avatar
for the agent chat that shows what the assistant is doing. Both can be the
Retainer mark.

The mark already tells the product's story. The ring is the memory, the
square is the thing being kept, and the gap is the way in. Each state is a
motion of those two parts, so the avatar has no face. An earlier try gave the
ring eyes, using the open-bot-avatar renderer. Without eyes that renderer has
only tilt and squash left, which on a thin ring reads as a wobble.

## 2. Color

The logo was drawn for dark backgrounds. Lime `#D4FA38` on white has a
contrast of 1.2:1, so the ring disappears on a light page.

| Where                | Ring                                               | Square          |
| -------------------- | -------------------------------------------------- | --------------- |
| Dark page            | Lime `#D4FA38`                                     | Coral `#FF603F` |
| Light page           | Lime fading to forest `#1F5E3A`, fixed to the page | Coral `#FF603F` |
| On the tile (`tile`) | Lime, on the ink tile `#111B21` in both themes     | Coral `#FF603F` |

On a light page the gradient runs from lime at the top right, where the gap
sits at rest, to forest green at 55% of the way to the bottom left. The forest
end is 7.7:1 on white. The gradient stays fixed to the page while the ring
turns through it, so the gap and the square move from lime into green and
back. A gradient that turned with the ring was also tried; it kept the lime
end on the gap at all times and read as less calm.

The light version follows `prefers-color-scheme`, as the rest of the app does.
Other light-mode options were tried and set aside: an ink ring (kept as the
fallback if the gradient doesn't work somewhere), olive, other dark single
colors, outlines, badges and stickers.

## 3. Moods

Every motion runs in the logo's 800 viewBox around the ring's center
(400, 400) or the square's center (613, 177). While the ring turns, the square
turns back by the same amount, so it travels the circle without rotating.

| Mood      | Motion                                                                                 | Cycle |
| --------- | -------------------------------------------------------------------------------------- | ----- |
| idle      | Nearly still; the square drifts out of the gap and back                                | 3.2 s |
| listening | The whole mark breathes in, to 106%                                                    | 1.6 s |
| thinking  | A steady spin                                                                        | 1.4 s |
| reading   | The gap scans back and forth, pausing at each end                                      | 2.4 s |
| saving    | The square shrinks into the ring, the ring takes it in, a new one comes out of the gap | 2.2 s |
| working   | One eased turn, then a beat at rest. Also the loading indicator                        | 1.6 s |
| done      | Plays once: a quick turn and a pop of the square, then idle                            | 0.9 s |
| error     | Plays once: the square shakes in the gap, then idle                                    | 0.6 s |

Loading uses the original working motion (variant A): a 1.12-second eased
turn followed by a 0.48-second pause, with `cubic-bezier(0.65, 0, 0.35, 1)`.

## 4. Changing mood

Every cycle starts and ends at rest. A new mood waits for the shown one to
finish its cycle, so the mark never jumps. `moodReducer` holds the rule and
has its own tests. The end of a cycle comes from the mood's main animation
(`animationiteration`, or `animationend` for done and error). A timer of one
cycle plus 250 ms finishes it when no animation event arrives, for example
when motion is reduced or the tab is hidden.

Done and error return to idle when they end. To play one again, the caller
changes the mood away and back, or remounts the mark.

## 5. Reduced motion

With `prefers-reduced-motion: reduce` nothing animates. Each mood has a still
pose: thinking and working turned a quarter, reading turned to one end of its
scan, and saving with the square inside the ring. A mood changes at once.
Callers say what is happening in words next to the mark, so the pose is never
the only signal.

## 6. Size and use

- The mark fills its box. Without a tile it fills 92% of it; on the tile, 64%.
- Use 32 px or more. At 28 px the square is about 2 px and the moods that move
  only the square (idle, saving, error) are hard to tell apart.
- It is decorative unless given a `label`. Next to a status text, leave the
  label out; the text is the accessible name.
- `Loading` (in `ui/index.tsx`) is the page-level loading state: the mark
  working (turn, then pause) at 32 px beside a sentence, inside `role="status"`.
  Startup uses `Splash` at 40 px, with the same animation and phase preserved
  from the HTML splash through React. Lists keep their
  placeholder rows (`EntryLoading`), which show the shape of what is coming.

## 7. Open questions

- Which agent events set which mood in the chat. A first guess: listening
  while the person types, thinking before the first tool call, reading for
  search and read tools, saving for writes, working while the answer streams,
  done when the turn ends, error when it fails.
- Whether the header's `BrandMark` and the favicon should follow the light
  version. Both keep the dark tile for now.
