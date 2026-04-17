cmake_minimum_required(VERSION 3.10)

project(Launcher)

if (WIN32)
    message(STATUS "MSVC -> forcing use of statically-linked runtime.")
    STRING(REPLACE "/MD" "/MT" CMAKE_CXX_FLAGS_RELEASE ${CMAKE_CXX_FLAGS_RELEASE})
    STRING(REPLACE "/MDd" "/MTd" CMAKE_CXX_FLAGS_DEBUG ${CMAKE_CXX_FLAGS_DEBUG})
endif(WIN32)

set(CMAKE_CXX_STANDARD 20)

# Helps clangd / IDE find headers when using Ninja or Makefile generators (compile_commands.json).
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(CMAKE_CXX_FLAGS_DEBUG "${CMAKE_CXX_FLAGS_DEBUG} -DDEBUG")

add_compile_definitions(CPPHTTPLIB_OPENSSL_SUPPORT)

file(GLOB source_files "src/*.cpp" "src/*/*.cpp" "src/*/*.hpp" "include/*.h"  "include/*/*.h" "include/*/*/*.h" "include/*.hpp"  "include/*/*.hpp" "include/*/*/*.hpp")
find_package(httplib CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(CURL REQUIRED)

add_executable(${PROJECT_NAME} ${source_files})
set_target_properties(${PROJECT_NAME} PROPERTIES OUTPUT_NAME "BeamMP-Launcher")

if (WIN32)
    find_package(ZLIB REQUIRED)
    find_package(OpenSSL REQUIRED)
    target_link_libraries(${PROJECT_NAME} PRIVATE
            ZLIB::ZLIB OpenSSL::SSL OpenSSL::Crypto ws2_32 httplib::httplib nlohmann_json::nlohmann_json CURL::libcurl)
elseif (UNIX)
    find_package(ZLIB REQUIRED)
    find_package(OpenSSL REQUIRED)
    target_link_libraries(${PROJECT_NAME} PRIVATE
            ZLIB::ZLIB OpenSSL::SSL OpenSSL::Crypto CURL::libcurl
            httplib::httplib nlohmann_json::nlohmann_json)
else(WIN32) #MINGW
    add_definitions("-D_WIN32_WINNT=0x0600")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Os -s --static")
    target_link_libraries(${PROJECT_NAME} ssl crypto ws2_32 ssp crypt32 z CURL::libcurl)
endif(WIN32)
target_include_directories(${PROJECT_NAME} PRIVATE "include")

# Optional: copy BeamMP-Server next to BeamMP-Launcher after build (same directory as GetBP() at runtime).
# Example: cmake -B build -DBEAMMP_SERVER_BINARY=C:/path/to/BeamMP-Server.exe
set(BEAMMP_SERVER_BINARY "" CACHE FILEPATH "Path to BeamMP-Server executable to copy beside the launcher (optional)")
if(BEAMMP_SERVER_BINARY)
    if(EXISTS "${BEAMMP_SERVER_BINARY}")
        add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${BEAMMP_SERVER_BINARY}"
                $<TARGET_FILE_DIR:${PROJECT_NAME}>
            COMMENT "Copying BeamMP-Server next to launcher")
    else()
        message(WARNING "BEAMMP_SERVER_BINARY points to a missing file: ${BEAMMP_SERVER_BINARY}")
    endif()
endif()
