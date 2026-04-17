#pragma once

#include <map>

#include "evpp/inner_pre.h"
#include "evpp/event_loop.h"
#include "evpp/httpc/conn.h"
#include "evpp/libevent.h"

struct evhttp_connection;
namespace evpp {
namespace httpc {
class ConnPool;
class Response;
class Request;
class Conn;
typedef void (*Handler)(const std::shared_ptr<Response>&, Request*);

class EVPP_EXPORT Request {
public:
    // @brief Create a HTTP Request and create Conn from pool.
    //  Do a HTTP GET request if body is empty or HTTP POST request if body is not empty.
    // @param[in] pool -
    // @param[in] loop -
    // @param[in] uri_with_param - The URI of the HTTP request with parameters
    // @param[in] body -
    // @return  -
    Request(ConnPool* pool, EventLoop* loop, std::string  uri_with_param, std::string  body);

    // @brief Create a HTTP Request and create Conn myself
    //  Do a HTTP GET request if body is empty or HTTP POST request if body is not empty.
    // @param[in] loop -
    // @param[in] url - The URL of the HTTP request
    // @param[in] body -
    // @param[in] timeout -
    // @return -
    Request(EventLoop* loop, const std::string& url, std::string  body, Duration timeout);

    ~Request();

    void Execute(const Handler& h);

    const std::string& uri() const {
        return uri_;
    }
    const std::string& host() const {
        return host_;
    }
    int port() const {
        return port_;
    }
    void set_retry_number(int v) {
        retry_number_ = v;
    }
    void set_progress_callback(void (*pr)(size_t, size_t)){
        progress_ = pr;
    }
    void set_retry_interval(Duration d) {
        retry_interval_ = d;
    }
    void set_request_type(evhttp_cmd_type Type){
        RequestType_ = Type;
    }
    void AddHeader(const std::string& header, const std::string& value);
private:
    static void ReadChunkCallback(struct evhttp_request* r, void* v);
    static void HandleResponse(struct evhttp_request* r, void* v);
    void HandleResponse(struct evhttp_request* r);
    void ExecuteInLoop();
    void Retry();
protected:
    static const std::string empty_;
private:
    ConnPool* pool_ = nullptr;
    EventLoop* loop_;
    std::string host_;
    int port_;
    std::string uri_; // The URI of the HTTP request with parameters
    std::map<std::string, std::string> headers_;
    std::string body_;
    std::shared_ptr<Conn> conn_;
    Handler handler_;

    evhttp_cmd_type RequestType_ = EVHTTP_REQ_GET;

    // this function if set will be called with downloaded / total
    void (*progress_)(size_t, size_t) = nullptr;
    //final response if there was a progress bar
    std::vector<char> response_body_;

    // The retried times
    int retried_ = 0;

    // The max retry times. Set to 0 if you don't want to retry when failed.
    // The total execution times is retry_number_+1
    int retry_number_ = 2;

    // Default : 1ms
    Duration retry_interval_ = Duration(0.001);
};
typedef std::shared_ptr<Request> RequestPtr;

class GetRequest : public Request {
public:
    GetRequest(ConnPool* pool, EventLoop* loop, const std::string& uri_with_param)
        : Request(pool, loop, uri_with_param, empty_) {
        set_request_type(EVHTTP_REQ_GET);
    }

    GetRequest(EventLoop* loop, const std::string& url, Duration timeout)
        : Request(loop, url, empty_, timeout) {
        set_request_type(EVHTTP_REQ_GET);
    }
};

class PostRequest : public Request {
public:
    PostRequest(ConnPool* pool, EventLoop* loop, const std::string& uri_with_param, const std::string& body)
        : Request(pool, loop, uri_with_param, body) {
        set_request_type(EVHTTP_REQ_POST);
    }

    PostRequest(EventLoop* loop, const std::string& url, const std::string& body, Duration timeout)
        : Request(loop, url, body, timeout) {
        set_request_type(EVHTTP_REQ_POST);
    }
};

} // httpc
} // evpp
