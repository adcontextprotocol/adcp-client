---
'@adcp/sdk': patch
---

Stop rejecting a whole `get_products` response because a seller's canonical `format_options` declaration disagrees with an AAO naming guess about a `v1_format_ref` under the seller's own `agent_url`. Two shapes were refused with "does not narrow its v1_format_ref" or "divergent legacy and canonical format declarations": a `video_hosted` size range declared for an id the AAO catalog also publishes once (the bare-id alias), and a `display_tag` declared for an unsuffixed display size id (the registry id-glob). Those guesses describe the AAO agent; under any other agent URL the seller's own agent owns what its ids mean. The dual-declaration check now lets an exact catalog entry, a projection catalog, or the explicit legacy converter decide in either direction, and an AAO naming guess under a non-AAO `agent_url` can only confirm a declaration, never reject it. Refs under the AAO agent are checked as before.
