use std::sync::Arc;

use hypr_db_core::Db;

const DB_FILENAME: &str = "app.db";

pub async fn open_desktop_db(identifier: &str) -> Arc<Db> {
    let db_path = desktop_db_dir(identifier).and_then(|dir| {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::error!(error = %e, "failed to create app data dir");
            return None;
        }
        Some(dir.join(DB_FILENAME))
    });

    match tauri_plugin_db::open_app_db(db_path.as_deref()).await {
        Ok(db) => Arc::new(db),
        Err(e) => {
            tracing::error!(error = %e, "failed to open app database, falling back to in-memory");
            match tauri_plugin_db::open_app_db(None).await {
                Ok(db) => Arc::new(db),
                Err(e2) => {
                    tracing::error!(error = %e2, "in-memory database also failed");
                    panic!("failed to open any database: {e} / {e2}")
                }
            }
        }
    }
}

fn desktop_db_dir(identifier: &str) -> Option<std::path::PathBuf> {
    let data_dir = dirs::data_dir()?;
    let default_dir = hypr_storage::global::compute_default_base(identifier)?;
    let identifier_dir = data_dir.join(identifier);

    if identifier_dir.join(DB_FILENAME).is_file() && !default_dir.join(DB_FILENAME).is_file() {
        Some(identifier_dir)
    } else {
        Some(default_dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_uses_an_isolated_persistent_database() {
        let db_dir = desktop_db_dir("com.hyprnote.dev").unwrap();

        assert!(db_dir.ends_with("com.hyprnote.dev"));
    }
}
