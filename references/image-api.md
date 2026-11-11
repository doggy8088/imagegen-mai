# MAI image API quick reference

This file summarizes the Microsoft Foundry MAI image API that `scripts/image_gen.js` calls. The source is the Microsoft Learn article [Deploy and use MAI image models in Microsoft Foundry](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image) (page dated 2026-09-21). Re-check that page when a request fails with `400 Bad Request` for a reason this file does not explain.

## Models

| Model | Version | Generations | Edits | Max `width x height` | `auto_aspect_ratio` / `web_grounding` |
| --- | --- | --- | --- | --- | --- |
| `MAI-Image-2.6-Flash` (CLI default) | `2026-07-31` | Yes | Yes | 2,359,296 | Yes |
| `MAI-Image-2.6` | `2026-07-31` | Yes | Yes | 2,359,296 | Yes |
| `MAI-Image-2.5-Pro` | `2026-06-19` | Yes | Yes | 1,048,576 | No |
| `MAI-Image-2.5-Flash` | `2026-06-02` | Yes | Yes | 1,048,576 | No |
| `MAI-Image-2.5` | `2026-06-02` | Yes | Yes | 1,048,576 | No |
| `MAI-Image-2`, `MAI-Image-2e` (earlier) | n/a | Yes | Not documented | 1,048,576 | No |

- All models deploy as Global Standard.
- `MAI-Image-2.6-Flash` has the same generation and editing capabilities as `MAI-Image-2.6`. It is faster and cheaper.
- Status: the Learn page (2026-09-21) lists the MAI-Image-2.6 models as Preview. The Microsoft Foundry blog announced general availability of `MAI-Image-2.6` and `MAI-Image-2.6-Flash` on 2026-10-27. Check the Foundry portal for the current status.
- `MAI-Image-2` and `MAI-Image-2e` are no longer listed on the current Learn page. Their limits come from the Microsoft Foundry [forgebook notebook](https://microsoft-foundry.github.io/forgebook/notebook/mai-image-2), which documents only the generations API (each side at least 768, total pixels at most 1,048,576). Edits are not documented for them, so the CLI blocks `edit` on these models.

## Endpoints

```text
POST https://<resource-name>.services.ai.azure.com/mai/v1/images/generations   (application/json)
POST https://<resource-name>.services.ai.azure.com/mai/v1/images/edits         (multipart/form-data)
```

- There is no `api-version` query parameter and no `/openai/deployments/{deployment}/` path segment.
- The deployment name goes in the `model` field of the body.
- The host is the Foundry resource host (`*.services.ai.azure.com`), not an Azure OpenAI host (`*.openai.azure.com`).

## Authentication

- API key: `api-key: <key>` header.
- Microsoft Entra ID: `Authorization: Bearer <token>`, with the token scoped to `https://cognitiveservices.azure.com/.default`.

## Request parameters

| Parameter | API | Type | Required | Notes |
| --- | --- | --- | --- | --- |
| `model` | Both | string | Yes | Deployment name. |
| `prompt` | Both | string | Yes | Up to 32,000 tokens. |
| `image` | Edits | file | Yes | JPEG or PNG. Repeat the field for up to five images. |
| `width` | Generations | integer | No | At least 768. |
| `height` | Generations | integer | No | At least 768. |
| `auto_aspect_ratio` | Both | boolean | No | MAI-Image-2.6 family only. The model picks the aspect ratio from the prompt and image inputs. |
| `web_grounding` | Both | boolean | No | MAI-Image-2.6 family only. The model can use Bing Search results as extra context. |

Size rules:

- `width` and `height` must each be at least 768 pixels.
- `width x height` must not exceed 2,359,296 (`1536x1536`) for the MAI-Image-2.6 family and 1,048,576 (`1024x1024`) for the MAI-Image-2.5 family.
- Either edge can exceed the square size if the total pixel count stays within the limit, for example `1920x1216` on MAI-Image-2.6 or `1280x768` on MAI-Image-2.5.
- The docs list `width` and `height` only for the generations API. The CLI does not send them on edits.

There are no `n`, `quality`, `size`, `background`, `output_format`, `output_compression`, `moderation`, `input_fidelity`, or `mask` parameters.

## Response

```json
{
  "data": [
    { "b64_json": "<base64-encoded PNG image data>" }
  ]
}
```

The output is always PNG.

## Rate limits (requests per minute, Global Standard)

| Tier | MAI-Image-2.6-Flash | MAI-Image-2.6 | MAI-Image-2.5-Pro | MAI-Image-2.5-Flash | MAI-Image-2.5 |
| --- | --- | --- | --- | --- | --- |
| 0 (Free) | 0 | 0 | 0 | 0 | 0 |
| 1 | 6 | 6 | 2 | 2 | 2 |
| 2 | 12 | 12 | 4 | 4 | 4 |
| 3 | 18 | 18 | 6 | 6 | 6 |
| 4 | 24 | 24 | 8 | 8 | 8 |
| 5 | 30 | 30 | 10 | 10 | 10 |
| 6 | 36 | 36 | 12 | 12 | 12 |

Keep `generate-batch --concurrency` low (the default is 2). The CLI retries `429` responses and honors `Retry-After`.

## Errors

| Error | Cause | Fix |
| --- | --- | --- |
| `401 Unauthorized` | Invalid API key or expired token | Regenerate the key, or get a token scoped to `https://cognitiveservices.azure.com/.default`. |
| `404 Not Found` | Wrong deployment name or endpoint | Check the deployment name and the `*.services.ai.azure.com` endpoint in the Foundry portal. |
| `400 Bad Request` | Missing field, unsupported image format, invalid size, or a parameter the model does not support | Send `model` and `prompt`; for edits, send at least one JPEG or PNG; keep sizes within the limits; use `auto_aspect_ratio` and `web_grounding` only with MAI-Image-2.6 models. |
| `429 Too Many Requests` | Rate limit exceeded | Wait and retry, or request a quota increase. |

## Pricing (MAI-Image-2.6 family, from the 2026-10-27 GA announcement)

| Model | Text input / 1M tokens | Image input / 1M tokens | Image output / 1M tokens |
| --- | --- | --- | --- |
| `MAI-Image-2.6-Flash` | USD 1.75 | USD 2.50 | USD 19.00 |
| `MAI-Image-2.6` | USD 5.00 | USD 8.00 | USD 38.00 |

## Responsible AI notes

- Photorealistic edits that involve minors are blocked by default.
- Disclose that content is AI-generated when you publish it.
