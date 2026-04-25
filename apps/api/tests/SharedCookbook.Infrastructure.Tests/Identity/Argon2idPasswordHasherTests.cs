using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Identity;
using Microsoft.AspNetCore.Identity;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Identity;

/// <summary>
/// Exercises the Argon2id hasher used behind ASP.NET Identity's IPasswordHasher.
/// Tests hit the real Argon2 implementation so a regression in parameters
/// (memory/time cost) or in salt generation is caught.
/// </summary>
public class Argon2idPasswordHasherTests
{
    private readonly Argon2idPasswordHasher _hasher = new();
    private readonly User _user = new();

    [Fact]
    public void HashPassword_Produces_Argon2id_Prefixed_Hash()
    {
        var hash = _hasher.HashPassword(_user, "s3cr3t-password");

        Assert.StartsWith("$argon2id$", hash);
    }

    [Fact]
    public void HashPassword_Uses_Random_Salt()
    {
        var hashA = _hasher.HashPassword(_user, "same-password");
        var hashB = _hasher.HashPassword(_user, "same-password");

        Assert.NotEqual(hashA, hashB);
    }

    [Fact]
    public void VerifyHashedPassword_Succeeds_On_Correct_Password()
    {
        var hash = _hasher.HashPassword(_user, "correct horse battery staple");

        var result = _hasher.VerifyHashedPassword(_user, hash, "correct horse battery staple");

        Assert.Equal(PasswordVerificationResult.Success, result);
    }

    [Fact]
    public void VerifyHashedPassword_Fails_On_Wrong_Password()
    {
        var hash = _hasher.HashPassword(_user, "correct horse battery staple");

        var result = _hasher.VerifyHashedPassword(_user, hash, "incorrect password");

        Assert.Equal(PasswordVerificationResult.Failed, result);
    }

    [Fact]
    public void VerifyHashedPassword_Fails_On_Tampered_Hash()
    {
        var hash = _hasher.HashPassword(_user, "correct horse battery staple");
        // Mutate a character deep inside the hash-bytes segment (after
        // the last `$`) so the change always lands on meaningful
        // base64-encoded hash payload. Flipping the last char used to
        // sometimes hit a padding-equivalent position, producing a
        // "tampered" hash Argon2 still verified successfully (flaky CI).
        var lastDollar = hash.LastIndexOf('$');
        var hashStart = lastDollar + 1;
        var pivot = hashStart + (hash.Length - hashStart) / 2;
        var original = hash[pivot];
        var swap = original == 'A' ? 'B' : 'A';
        var tampered = hash[..pivot] + swap + hash[(pivot + 1)..];

        var result = _hasher.VerifyHashedPassword(_user, tampered, "correct horse battery staple");

        Assert.Equal(PasswordVerificationResult.Failed, result);
    }

    [Fact]
    public void VerifyHashedPassword_Fails_Gracefully_On_Garbage()
    {
        var result = _hasher.VerifyHashedPassword(_user, "not-a-real-hash", "anything");

        Assert.Equal(PasswordVerificationResult.Failed, result);
    }
}
