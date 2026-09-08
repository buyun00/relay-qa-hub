using COSXML.CosException;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace Ozdqp;

public static class CosDiagnostics
{
    static string Safe(string? value) => value != null && Regex.IsMatch(value, "^[A-Za-z0-9_.:-]{1,160}$") ? value : "";
    public static object Describe(Exception error)
    {
        // SDK messages, response bodies and URLs can contain credentials. Record
        // only bounded identifiers, numeric status and transport exception types.
        var result = new Dictionary<string, object?> { ["type"] = error.GetType().Name };
        if (error is CosServerException server)
        {
            result["httpStatus"] = server.statusCode;
            result["serviceCode"] = Safe(server.errorCode);
            result["requestId"] = Safe(server.requestId);
        }
        if (error is CosClientException client) result["clientCode"] = client.errorCode;
        if (error is WebException web) result["transportStatus"] = web.Status.ToString();
        if (error is SocketException socket) result["socketError"] = socket.SocketErrorCode.ToString();
        if (error.InnerException is {} inner && !ReferenceEquals(inner, error)) result["inner"] = Describe(inner);
        return result;
    }
}
