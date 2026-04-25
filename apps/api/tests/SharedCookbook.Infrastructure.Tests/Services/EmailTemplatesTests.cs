using SharedCookbook.Infrastructure.Services;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

/// <summary>
/// PF3 — sanity-checks the three plain-text templates so the centralised
/// <see cref="EmailTemplates"/> file stays the source of truth. Kept
/// deliberately small: the content round-trip is already exercised by
/// <see cref="SmtpEmailSenderTests"/>; these tests only prove the
/// placeholders substitute correctly and German copy is intact.
/// </summary>
public class EmailTemplatesTests
{
    [Fact]
    public void PasswordReset_Subject_Is_German_And_Stable()
    {
        Assert.Equal("Passwort zurücksetzen — Familien-Kochbuch", EmailTemplates.PasswordResetSubject);
    }

    [Fact]
    public void PasswordReset_Body_Substitutes_Name_And_Url()
    {
        var body = EmailTemplates.PasswordResetBody("Anna", "https://app.local/reset?t=abc");
        Assert.Contains("Hallo Anna,", body);
        Assert.Contains("https://app.local/reset?t=abc", body);
        Assert.Contains("gültig 24 Stunden", body);
    }

    [Fact]
    public void AppInvite_Body_Omits_Personal_Note_When_Null_Or_Blank()
    {
        var bodyNull = EmailTemplates.AppInviteBody("Bernd", "https://app.local/signup?invite=x", null);
        var bodyBlank = EmailTemplates.AppInviteBody("Bernd", "https://app.local/signup?invite=x", "   ");
        Assert.DoesNotContain("Persönliche Nachricht", bodyNull);
        Assert.DoesNotContain("Persönliche Nachricht", bodyBlank);
    }

    [Fact]
    public void AppInvite_Body_Includes_Personal_Note_When_Present()
    {
        var body = EmailTemplates.AppInviteBody("Bernd", "https://app.local/signup?invite=x", "freu mich!");
        Assert.Contains("Persönliche Nachricht von Bernd:", body);
        Assert.Contains("freu mich!", body);
    }

    [Fact]
    public void GroupInvite_Subject_Embeds_Group_Name()
    {
        var subject = EmailTemplates.GroupInviteSubject("Familie Mustermann");
        Assert.Contains("Familie Mustermann", subject);
        Assert.Contains("Familien-Kochbuch", subject);
    }

    [Fact]
    public void GroupInvite_Body_Has_Inviter_GroupName_And_AcceptUrl()
    {
        var body = EmailTemplates.GroupInviteBody(
            "Claudia", "Koch-Crew", "https://app.local/groups?invite=42");
        Assert.Contains("Claudia", body);
        Assert.Contains("Koch-Crew", body);
        Assert.Contains("https://app.local/groups?invite=42", body);
    }
}
