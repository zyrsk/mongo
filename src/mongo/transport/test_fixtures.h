/**
 *    Copyright (C) 2023-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#pragma once

#include <functional>
#include <memory>
#include <queue>

#include "mongo/logv2/log.h"
#include "mongo/stdx/thread.h"
#include "mongo/transport/service_entry_point.h"
#include "mongo/transport/session.h"

#define MONGO_LOGV2_DEFAULT_COMPONENT ::mongo::logv2::LogComponent::kTest

namespace mongo::transport::test {

template <typename T>
class BlockingQueue {
public:
    void push(T t) {
        stdx::unique_lock lk(_mu);
        _q.push(std::move(t));
        lk.unlock();
        _cv.notify_one();
    }

    T pop() {
        stdx::unique_lock lk(_mu);
        _cv.wait(lk, [&] { return !_q.empty(); });
        T r = std::move(_q.front());
        _q.pop();
        return r;
    }

private:
    mutable Mutex _mu;
    mutable stdx::condition_variable _cv;
    std::queue<T> _q;
};

class JoinThread : public stdx::thread {
public:
    using stdx::thread::thread;
    ~JoinThread() {
        if (joinable())
            join();
    }
};

struct SessionThread {
    struct StopException {};

    explicit SessionThread(std::shared_ptr<transport::Session> s)
        : _session{std::move(s)}, _thread{[this] {
              _run();
          }} {}

    ~SessionThread() {
        if (!_thread.joinable())
            return;
        schedule([](auto&&) { throw StopException{}; });
    }

    void schedule(std::function<void(transport::Session&)> task) {
        _tasks.push(std::move(task));
    }

    transport::Session& session() const {
        return *_session;
    }

private:
    void _run() {
        while (true) {
            try {
                LOGV2(6109508, "SessionThread: pop and execute a task");
                _tasks.pop()(*_session);
            } catch (const StopException&) {
                LOGV2(6109509, "SessionThread: stopping");
                return;
            }
        }
    }

    std::shared_ptr<transport::Session> _session;
    BlockingQueue<std::function<void(transport::Session&)>> _tasks;
    JoinThread _thread;  // Appears after the members _run uses.
};

class MockSEP : public ServiceEntryPoint {
public:
    MockSEP() = default;
    explicit MockSEP(std::function<void(SessionThread&)> onStartSession)
        : _onStartSession(std::move(onStartSession)) {}

    ~MockSEP() override {
        _join();
    }

    Status start() override {
        return Status::OK();
    }

    void appendStats(BSONObjBuilder*) const override {}

    Future<DbResponse> handleRequest(OperationContext* opCtx,
                                     const Message& request) noexcept override {
        MONGO_UNREACHABLE;
    }

    void startSession(std::shared_ptr<transport::Session> session) override {
        LOGV2(6109510, "Accepted connection", "remote"_attr = session->remote());
        auto& newSession = [&]() -> SessionThread& {
            auto vec = *_sessions;
            vec->push_back(std::make_unique<SessionThread>(std::move(session)));
            return *vec->back();
        }();
        if (_onStartSession)
            _onStartSession(newSession);
        LOGV2(6109511, "started session");
    }

    void endAllSessions(transport::Session::TagMask tags) override {
        _join();
    }

    bool shutdown(Milliseconds timeout) override {
        _join();
        return true;
    }

    size_t numOpenSessions() const override {
        return _sessions->size();
    }

    logv2::LogSeverity slowSessionWorkflowLogSeverity() override {
        MONGO_UNIMPLEMENTED;
    }

    void setOnStartSession(std::function<void(SessionThread&)> cb) {
        _onStartSession = std::move(cb);
    }

private:
    void _join() {
        LOGV2(6109513, "Joining all session threads");
        _sessions->clear();
    }

    std::function<void(SessionThread&)> _onStartSession;
    synchronized_value<std::vector<std::unique_ptr<SessionThread>>> _sessions;
};
}  // namespace mongo::transport::test

#undef MONGO_LOGV2_DEFAULT_COMPONENT
