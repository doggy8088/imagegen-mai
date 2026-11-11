# Prompting best practices

These prompting principles apply to the bundled `scripts/image_gen.js` CLI workflow.

This file is about prompt structure, specificity, and iteration. CLI execution controls such as the deployment, `width`/`height`, `auto_aspect_ratio`, `web_grounding`, and output paths live in the CLI docs.

## Contents
- [Structure](#structure)
- [Specificity policy](#specificity-policy)
- [Allowed and disallowed augmentation](#allowed-and-disallowed-augmentation)
- [Composition and layout](#composition-and-layout)
- [Constraints and invariants](#constraints-and-invariants)
- [Text in images](#text-in-images)
- [Input images and references](#input-images-and-references)
- [Iterate deliberately](#iterate-deliberately)
- [Transparent images](#transparent-images)
- [CLI execution controls](#cli-execution-controls)
- [Use-case tips](#use-case-tips)
- [Where to find copy/paste recipes](#where-to-find-copypaste-recipes)

## Structure
- Use a consistent order: scene/backdrop -> subject -> key details -> constraints -> output intent.
- Include intended use (ad, UI mock, infographic) to set the level of polish.
- For complex requests, use short labeled lines instead of one long paragraph.

## Specificity policy
- If the user prompt is already specific and detailed, normalize it into a clean spec without adding creative requirements.
- If the prompt is generic, you may add tasteful detail when it materially improves the output.
- Treat examples in `sample-prompts.md` as fully-authored recipes, not as the default amount of augmentation to add to every request.
- For photorealism, include `photorealistic` directly when that is the goal, plus concrete real-world texture such as pores, wrinkles, fabric wear, material grain, or imperfect everyday detail.

## Allowed and disallowed augmentation

Allowed augmentation for generic prompts:

- composition and framing cues
- intended-use or polish-level hints
- practical layout guidance
- reasonable scene concreteness that supports the request

Do not add:

- extra characters, props, or objects that are not implied
- brand palettes, slogans, or story beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Composition and layout
- Specify framing and viewpoint (close-up, wide, top-down) and placement only when it materially helps.
- Call out negative space if the asset clearly needs room for UI or copy.
- Avoid making left/right layout decisions unless the user or surrounding layout supports them.
- For people, describe body framing, scale, gaze, and object interactions when they matter (`full body visible`, `looking down at the book`, `hands naturally gripping the handlebars`).

## Constraints and invariants
- State what must not change (`keep background unchanged`).
- For edits, say `change only X; keep Y unchanged` and repeat invariants on every iteration to reduce drift.

## Text in images
- Put literal text in quotes or ALL CAPS and specify typography (font style, size, color, placement).
- Spell uncommon words letter-by-letter if accuracy matters.
- For in-image copy, require verbatim rendering and no extra characters.
- MAI image models have no quality setting. For small text, dense infographics, data-heavy slides, legends, axes, and footnotes, use the largest canvas the model allows (up to 2,359,296 pixels on the MAI-Image-2.6 family, for example `1536x1536` or `1920x1216`) and keep the amount of text modest.

## Input images and references
- Do not assume that every provided image is an edit target.
- Label each image by index and role (`Image 1: edit target`, `Image 2: style reference`).
- If the user provides images for style, composition, or mood guidance and does not ask to modify them, treat the request as generation with references.
- If the user asks to preserve an existing image while changing specific parts, treat the request as an edit.
- For compositing, describe how the images interact (`place the subject from Image 2 into Image 1`).

## Iterate deliberately
- Start with a clean base prompt, then make small single-change edits.
- Re-specify critical constraints when you iterate.
- Prefer one targeted follow-up at a time over rewriting the whole prompt.

## Transparent images
- MAI image models always return an opaque PNG. There is no `background=transparent` parameter, so transparent assets always use the chroma-key workflow below.
- Prompt for the subject on a perfectly flat solid chroma-key background, usually `#00ff00`; use `#ff00ff` when the subject is green, and avoid key colors that appear in the subject.
- Explicitly prohibit shadows, gradients, floor planes, reflections, texture, and lighting variation in the background, and ask for crisp edges, generous padding, and no use of the key color inside the subject.
- After generation, remove the background locally with `node "<skill-dir>/scripts/remove_chroma_key.js" --input <source> --out <final.png> --auto-key border --soft-matte --transparent-threshold 12 --opaque-threshold 220 --despill` and validate the alpha result before shipping it.
- Validate that the output has an alpha channel, transparent corners, a substantial share of fully transparent pixels, and no key-color fringe.
- Use soft matte and despill for antialiased edges; hard tolerance-only removal is mainly for flat pixel-art or exact-color fixtures.
- Chroma keying is a poor fit for hair, fur, glass, smoke, liquids, translucent materials, reflective objects, or soft shadows. Tell the user about that limit before promising a clean cutout for those subjects.

## CLI execution controls
- The deployment (`--model`), `--width`/`--height` (or `--size`), `--auto-aspect-ratio`, `--web-grounding`, and output paths are CLI execution controls.
- See `references/cli.md` and `references/image-api.md` for those controls.
- In CLI mode, `MAI-Image-2.6-Flash` is the default. MAI image models do not expose `quality`, `n`, `background`, `output_format`, `input_fidelity`, or masks.
- Width and height must each be at least 768px. Their product must stay at or below 2,359,296 for the MAI-Image-2.6 family and 1,048,576 for the MAI-Image-2.5 family. 4K output is not available; the largest square is `1536x1536`.
- Use `--auto-aspect-ratio` (MAI-Image-2.6 family only) when the user has no size preference and the composition should decide the aspect ratio.
- Use `--web-grounding` (MAI-Image-2.6 family only) when the prompt depends on current real-world facts, places, products, or events.

## Use-case tips

Generate:

- photorealistic-natural: Prompt as if a real photo is captured in the moment; use photography language (lens, lighting, framing); call for real texture; avoid over-stylized polish unless requested.
- product-mockup: Describe the product/packaging and materials; ensure clean silhouette and label clarity; if in-image text is needed, require verbatim rendering and specify typography.
- ui-mockup: Describe the target fidelity first (shippable mockup or low-fi wireframe), then focus on layout, hierarchy, and practical UI elements; avoid concept-art language.
- infographic-diagram: Define the audience and layout flow; label parts explicitly; require verbatim text; use a larger canvas for dense labels.
- logo-brand: Keep it simple and scalable; ask for a strong silhouette and balanced negative space; avoid decorative flourishes unless requested.
- ads-marketing: Write like a creative brief; include brand positioning, audience, desired vibe, scene, and exact tagline if text must appear.
- productivity-visual: Name the exact artifact (slide, chart, workflow diagram), define the canvas and hierarchy, provide real labels/data, and ask for readable typography and polished spacing.
- scientific-educational: Define audience, lesson objective, required labels, scientific constraints, arrows, and scan-friendly whitespace.
- illustration-story: Define panels or scene beats; keep each action concrete.
- stylized-concept: Specify style cues, material finish, and rendering approach (3D, painterly, clay) without inventing new story elements.
- historical-scene: State the location/date and required period accuracy; constrain clothing, props, and environment to match the era.

Edit:

- text-localization: Change only the text; preserve layout, typography, spacing, and hierarchy; no extra words or reflow unless needed.
- identity-preserve: Lock identity (face, body, pose, hair, expression); change only the specified elements; match lighting and shadows.
- precise-object-edit: Specify exactly what to remove/replace; preserve surrounding texture and lighting; keep everything else unchanged.
- lighting-weather: Change only environmental conditions (light, shadows, atmosphere, precipitation); keep geometry, framing, and subject identity.
- background-extraction: Ask the model to place the isolated subject on a perfectly flat solid chroma-key background; crisp silhouette; generous padding; no shadows; no halos; preserve label text exactly; no restyling. Then remove the key color locally with `scripts/remove_chroma_key.js`.
- style-transfer: Specify style cues to preserve (palette, texture, brushwork) and what must change; add `no extra elements` to prevent drift.
- compositing: Reference inputs by index; specify what moves where; match lighting, perspective, and scale; keep the base framing unchanged.
- sketch-to-render: Preserve layout, proportions, and perspective; choose materials and lighting that support the supplied sketch without adding new elements.

## Where to find copy/paste recipes

For copy/paste prompt specs (examples only), see `references/sample-prompts.md`. This file focuses on principles, specificity, and iteration patterns.
