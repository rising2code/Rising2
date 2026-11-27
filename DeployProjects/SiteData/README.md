# Site data

What the landing page shows only after its captcha (the worker serves it from R2, Deploy step 05
uploads the first copy; after that edit the files in R2: dashboard > R2 > the bucket > `site/`):

* `site/urls.json` - the page's links, made from step 05's settings: `{"discord": ..., "github": ..., "download": ...}`.
  A link that's missing hides its buttons.
* `site/s3files.json` - from [s3files.json](s3files.json): the public resource archive. Each entry:

  ```json
  { "key": "maps/eiffel-tower.zip", "name": "Eiffel Tower map pack", "size": "120 MB", "about": "Custom map, 2008" }
  ```

  `key` is the file's path in the archive bucket (worker setting `S3_BUCKET`, OVH Object Storage, not
  public). The page asks the worker for a 10-minute signed link per download (`POST /api/sign-s3-1`),
  and only keys in this list can be signed. With no files the archive section stays hidden.
