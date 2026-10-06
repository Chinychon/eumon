-- Analysis findings, opportunities, competitors and plans live in
-- analyses.report_json; nothing reads or writes these tables any more.
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS competitors;
DROP TABLE IF EXISTS opportunities;
DROP TABLE IF EXISTS growth_plans;
DROP TABLE IF EXISTS crawl_snapshots;
DROP TABLE IF EXISTS audit_logs;
