namespace SharedCookbook.Domain.Enums;

/// <summary>
/// Phase-aware progress for a <see cref="Entities.RecipeImport"/>.
/// The <see cref="Entities.ImportStatus"/> state machine describes the
/// coarse lifetime of the import (Queued → Running → Done/Error); the
/// phase describes <em>within</em> Running which sub-phase the Python
/// extraction is currently running. Both values land on the wire
/// (<c>GET /api/imports/{id}</c> + SignalR event
/// <c>RecipeImportProgressChanged</c>) and the frontend uses them to
/// drive the phase-specific progress bar.
///
/// The explicitly assigned int values are part of the wire / on-disk
/// contract — new phases append at the end; existing values must never
/// shift. Monotonically increasing values enable the out-of-order
/// guard in <see cref="Entities.RecipeImport.UpdateProgress"/>.
/// </summary>
public enum RecipeImportPhase
{
    /// <summary>Import is queued — no Python call yet.</summary>
    Queued = 0,

    /// <summary>yt-dlp is downloading the video. URL path only.</summary>
    Downloading = 1,

    /// <summary>faster-whisper is transcribing the audio. URL path only.</summary>
    Transcribing = 2,

    /// <summary>Azure OpenAI is structuring the transcript text into recipe JSON.</summary>
    Structuring = 3,

    /// <summary>Post-processing on the .NET side (persistence, thumbnails).</summary>
    PostProcessing = 4,

    /// <summary>Azure Vision is analysing the photo(s). Photo path only; single-shot.</summary>
    VisionAnalysis = 5,

    /// <summary>Import complete; recipe stored.</summary>
    Done = 6,

    /// <summary>Terminal error state; <c>ErrorMessage</c> carries the reason.</summary>
    Error = 7,
}
