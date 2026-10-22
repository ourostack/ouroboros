use std::io;

use codex_protocol::openai_models::ModelsResponse;
use codex_protocol::openai_models::ToolMode;
use codex_protocol::protocol::MultiAgentVersion;

pub fn fixed_catalog() -> io::Result<ModelsResponse> {
    let mut catalog: ModelsResponse = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../models-manager/models.json"
    )))?;
    catalog.models.retain(|model| model.slug == "gpt-5.5");
    if catalog.models.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "pinned catalog must contain exactly one gpt-5.5 entry",
        ));
    }
    let model = &mut catalog.models[0];
    model.experimental_supported_tools.clear();
    model.multi_agent_version = Some(MultiAgentVersion::Disabled);
    model.tool_mode = Some(ToolMode::Direct);
    Ok(catalog)
}
