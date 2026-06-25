const pg = require("/app/node_modules/.pnpm/pg@8.20.0/node_modules/pg");
(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const log = (label, rows) => {
    console.log(`\n===== ${label} (${rows.length}) =====`);
    for (const r of rows) console.log(JSON.stringify(r));
  };

  // 1) Documents mentioning tania (gmail), newest first
  const docs = await c.query(
    `select id, source, source_id, source_thread_id, title,
            left(content, 120) as content_snippet,
            authored_at, ingested_at,
            metadata->>'from' as meta_from,
            metadata->>'to' as meta_to,
            metadata->>'subject' as meta_subject
       from documents
      where source = 'gmail'
        and (title ilike '%tania%' or content ilike '%tania%'
             or metadata::text ilike '%tania%')
      order by authored_at desc nulls last
      limit 40`
  );
  log("documents matching tania", docs.rows);

  // 2) Triage rows for those threads
  const threadIds = [...new Set(docs.rows.map((r) => r.source_thread_id).filter(Boolean))];
  if (threadIds.length) {
    const tri = await c.query(
      `select source_thread_id, category, confidence, source, model,
              document_id, classified_at, overridden_at, row_version,
              sender_significance_band
         from email_triage
        where source_thread_id = any($1::text[])
        order by classified_at desc`,
      [threadIds]
    );
    log("triage rows for those threads", tri.rows);
  } else {
    console.log("\n(no thread ids from docs)");
  }

  // 3) Any triage rows whose rationale mentions tania (in case doc was deleted)
  const triR = await c.query(
    `select source_thread_id, category, confidence, source, model,
            document_id, classified_at, overridden_at, left(rationale,160) as rationale
       from email_triage
      where rationale ilike '%tania%'
      order by classified_at desc
      limit 20`
  );
  log("triage rows w/ rationale mentioning tania", triR.rows);

  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
