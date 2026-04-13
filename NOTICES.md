# NOTICES

## Third-Party Attributions

### @secretlint/secretlint-rule-preset-recommend

Portions of `src/scrubber/baseline.generated.ts` are derived from or inspired by
[@secretlint/secretlint-rule-preset-recommend](https://github.com/secretlint/secretlint),
Copyright (c) Takuto Wada and contributors.

Licensed under the MIT License.

#### Rule Attribution

The following baseline rules were curated with reference to the secretlint preset:

| Rule ID                 | Source                                         |
| ----------------------- | ---------------------------------------------- |
| `anthropic-api-key`     | Curated (Anthropic-specific pattern)           |
| `aws-access-key-id`     | Inspired by secretlint AWS rule                |
| `aws-secret-access-key` | Inspired by secretlint AWS rule                |
| `github-token`          | Inspired by secretlint GitHub rule             |
| `gitlab-token`          | Inspired by secretlint GitLab rule             |
| `slack-token`           | Inspired by secretlint Slack rule              |
| `stripe-key`            | Inspired by secretlint Stripe rule             |
| `jwt`                   | Curated (standard JWT format)                  |
| `env-assignment`        | Curated (generic environment variable pattern) |

#### MIT License (secretlint)

```
MIT License

Copyright (c) Takuto Wada and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
