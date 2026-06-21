mod ci;
mod claude;
mod history;
mod stt;
mod terminal;
mod transcript;
mod tts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.handle().plugin(tauri_plugin_notification::init())?;
      Ok(())
    })
    .manage(stt::SttState::default())
    .manage(claude::ClaudeState::default())
    .manage(terminal::TerminalState::default())
    .invoke_handler(tauri::generate_handler![
      tts::tts_synthesize,
      tts::tts_list_voices,
      stt::stt_start,
      stt::stt_stop,
      stt::stt_finalize,
      stt::stt_set_vad_hangover,
      stt::stt_push_frame,
      claude::claude_start,
      claude::claude_submit,
      claude::claude_cancel,
      claude::claude_stop,
      terminal::terminal_spawn,
      terminal::terminal_write,
      terminal::terminal_kill,
      terminal::terminal_resize,
      ci::ci_status,
      history::history_load,
      history::history_save,
      transcript::transcript_save,
      transcript::transcript_load_latest,
      transcript::transcript_cleanup
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
