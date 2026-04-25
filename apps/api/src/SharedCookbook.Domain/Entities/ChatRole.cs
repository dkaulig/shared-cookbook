namespace SharedCookbook.Domain.Entities;

/// <summary>
/// CR1 — role discriminator on a <see cref="ChatMessage"/>.
///
/// Stored as <c>int</c> in the database so renames don't shift existing
/// rows. Matches the OpenAI / Azure-OpenAI chat-completions role enum.
/// </summary>
public enum ChatRole
{
    User = 0,
    Assistant = 1,
    System = 2,
}
