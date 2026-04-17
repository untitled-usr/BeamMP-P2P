#include "evpp/libevent.h"
#include "evpp/httpc/conn_pool.h"
#include "evpp/httpc/response.h"
#include "evpp/httpc/request.h"
#include "evpp/httpc/url_parser.h"

#if defined(EVPP_HTTP_CLIENT_SUPPORTS_SSL)
#include <openssl/err.h>

#include <memory>
#include <utility>
#include "evpp/httpc/ssl.h"
#endif

namespace evpp {
namespace httpc {
const std::string Request::empty_;

Request::Request(ConnPool* pool, EventLoop* loop, std::string http_uri, std::string body)
    : pool_(pool), loop_(loop), host_(pool->host()), port_(pool->port()), uri_(std::move(http_uri)), body_(std::move(body)) {
#if defined(EVPP_HTTP_CLIENT_SUPPORTS_SSL)
    if(!InitSSL()){
        LOG_ERROR << "InitSSL Failed!";
    }
#endif
}

Request::Request(EventLoop* loop, const std::string& http_url, std::string body, Duration timeout)
    : pool_(nullptr), loop_(loop), body_(std::move(body)) {

    //TODO performance compare
#if LIBEVENT_VERSION_NUMBER >= 0x02001500
    struct evhttp_uri* evuri = evhttp_uri_parse(http_url.c_str());
    uri_ = evhttp_uri_get_path(evuri);
    if (uri_[0] == 0) {
        uri_ = "/";
    }
    const char* query = evhttp_uri_get_query(evuri);
    if (query && strlen(query) > 0) {
        uri_ += "?";
        uri_ += query;
    }

    host_ = evhttp_uri_get_host(evuri);

    port_ = evhttp_uri_get_port(evuri);
#if defined(EVPP_HTTP_CLIENT_SUPPORTS_SSL)
    if(!InitSSL()){
        LOG_ERROR << "InitSSL Failed!";
    }
    const char* scheme = evhttp_uri_get_scheme(evuri);

    bool enable_ssl = scheme && std::string(scheme).find("https") == 0;

    if (port_ < 0) {
        port_ = enable_ssl ? 443 : 80;
    }
    conn_ = std::make_shared<Conn>(loop, host_, port_, enable_ssl, timeout);
#else
    if (port_ < 0) {
        port_ = 80;
    }
    conn_.reset(new Conn(loop, host_, port_, timeout));
#endif
    evhttp_uri_free(evuri);
#else
    URLParser p(http_url);
    conn_.reset(new Conn(loop, p.host, p.port, timeout));
    if (p.query.empty()) {
        uri_ = p.path;
    } else {
        uri_ = p.path + "?" + p.query;
    }
    host_ = p.host;
    port_ = p.port;
#endif
}

Request::~Request() {
    assert(loop_->IsInLoopThread());
}

void Request::Execute(const Handler& h) {
    handler_ = h;
    loop_->RunInLoop(std::bind(&Request::ExecuteInLoop, this));
}

void Request::ReadChunkCallback(struct evhttp_request* r, void* v) {
    auto* thiz = (Request*)v;
    assert(thiz);

    if(thiz->response_body_.empty()) {
        thiz->response_body_.reserve(r->body_size + r->ntoread);
    }

    thiz->progress_(r->body_size, thiz->response_body_.capacity());

    struct evbuffer* evbuf = evhttp_request_get_input_buffer(r);
    size_t buffer_size = evbuffer_get_length(evbuf);
    char* data = (char*)evbuffer_pullup(evbuf, -1);
    for(size_t i = 0; i < buffer_size; i++) {
        thiz->response_body_.push_back(data[i]);
    }
}

void Request::ExecuteInLoop() {
    DLOG_TRACE;
    assert(loop_->IsInLoopThread());

    std::string errmsg;
    struct evhttp_request* req = nullptr;

    if (conn_) {
        assert(pool_ == nullptr);
        if (!conn_->Init()) {
            errmsg = "conn init fail";
            goto failed;
        }
    } else {
        assert(pool_);
        conn_ = pool_->Get(loop_);
        if (!conn_->Init()) {
            errmsg = "conn init fail";
            goto failed;
        }
    }

    req = evhttp_request_new(&Request::HandleResponse, this);

    if (!req) {
        errmsg = "evhttp_request_new fail";
        goto failed;
    }

    if(progress_) {
        evhttp_request_set_chunked_cb(req, &Request::ReadChunkCallback);
    }

    if (evhttp_add_header(req->output_headers, "host", conn_->host().c_str())) {
        evhttp_request_free(req);
        errmsg = "evhttp_add_header failed";
        goto failed;
    }

    for (const auto& header : headers_) {
        if (evhttp_add_header(
                req->output_headers, header.first.c_str(), header.second.c_str())) {
            evhttp_request_free(req);
            errmsg = "evhttp_add_header failed";
            goto failed;
        }
    }

    if (!body_.empty()) {
        if (evbuffer_add(req->output_buffer, body_.c_str(), body_.size())) {
            evhttp_request_free(req);
            errmsg = "evbuffer_add fail";
            goto failed;
        }
    }

    if (evhttp_make_request(conn_->evhttp_conn(), req, RequestType_, uri_.c_str()) != 0) {
        // At here conn_ has owned this req, so don't need to free it.
        errmsg = "evhttp_make_request fail";
        goto failed;
    }

    return;

failed:
    // Retry
    if (retried_ < retry_number_) {
        LOG_WARN << "this=" << this << " http request failed : " << errmsg << " retried=" << retried_ << " max retry_time=" << retry_number_ << ". Try again.";
        Retry();
        return;
    }

    std::shared_ptr<Response> response(new Response(this, nullptr, response_body_));
    handler_(response, this);
}

void Request::AddHeader(const std::string& header, const std::string& value) {
    headers_[header] = value;
}

void Request::Retry() {
    retried_ += 1;

    // Recycling the http Connection object for retry.
    // Connection will be obtained again by ExecuteInLoop
    if (pool_) {
        pool_->Put(conn_);
        conn_.reset();
    }

    if (retry_interval_.IsZero()) {
        ExecuteInLoop();
    } else {
        loop_->RunAfter(retry_interval_, [this] { ExecuteInLoop(); });
    }
}

void Request::HandleResponse(struct evhttp_request* r, void* v) {
    auto* thiz = (Request*)v;
    assert(thiz);
    thiz->HandleResponse(r);
}

void Request::HandleResponse(struct evhttp_request* r) {
    assert(loop_->IsInLoopThread());

    if (r) {
        int response_code = r->response_code;
        bool needs_retry = response_code >= 500 && response_code < 600;
        if (!needs_retry || retried_ >= retry_number_) {
            LOG_WARN << "this=" << this << " response_code=" << r->response_code << " retried=" << retried_ << " max retry_time=" << retry_number_;

            std::shared_ptr<Response> response(new Response(this, r, response_body_));

            //Recycling the http Connection object
            if (pool_) {
                pool_->Put(conn_);
                conn_.reset();
            }

            handler_(response, this);
            return;
        }
    }

    // Retry
    if (retried_ < retry_number_) {
        LOG_WARN << "this=" << this << " response_code=" << (r ? r->response_code : 0) << " retried=" << retried_ << " max retry_time=" << retry_number_ << ". Try again";
        Retry();
        return;
    }

#if defined(EVPP_HTTP_CLIENT_SUPPORTS_SSL)
    if (!r) {
        int errcode = EVUTIL_SOCKET_ERROR();
        unsigned long oslerr;
        bool printed_some_error = false;
        char buffer[256];
        while ((oslerr = bufferevent_get_openssl_error(conn_->bufferevent()))) {
            ERR_error_string_n(oslerr, buffer, sizeof(buffer));
            LOG_ERROR << "Openssl error: " << buffer;
            printed_some_error = true;
        }
        if (!printed_some_error) {
            LOG_ERROR << "socket error(" << errcode << "): "
                << evutil_socket_error_to_string(errcode);
        }
    }
#endif
    // Eventually this Request failed
    std::shared_ptr<Response> response(new Response(this, r, response_body_));

    // Recycling the http Connection object
    if (pool_) {
        pool_->Put(conn_);
        conn_.reset();
    }

    handler_(response, this);
}

} // httpc
} // evpp


