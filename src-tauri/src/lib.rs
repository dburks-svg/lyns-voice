mod claude;
mod stt;
mod tts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .manage(stt::SttState::default())
    .manage(claude::ClaudeState::default())
    .invoke_handler(tauri::generate_handler![
      tts::tts_synthesize,
      stt::stt_start,
      stt::stt_stop,
      stt::stt_finalize,
      stt::stt_push_frame,
      claude::claude_start,
      claude::claude_submit,
      claude::claude_stop
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
